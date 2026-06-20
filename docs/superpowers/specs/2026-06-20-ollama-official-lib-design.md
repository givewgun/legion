# Ollama provider on the official `ollama` library — design

**Date:** 2026-06-20
**Branch:** `claude/ollama-official-lib`
**Status:** approved

## Problem

`src/llm/ollama.js` hand-rolls the Ollama call: a `fetch` POST to `/api/generate`
with `stream: false`, reading `.response` off the JSON. This works for the small
`qwen2.5` models but breaks down for the home-PC tier running `gpt-oss:20b` in
thinking mode:

- **Timeout mid-thinking.** A reasoning model can spend a long time producing
  thinking tokens before emitting the first byte of the final answer. With
  `stream: false` the whole response is buffered server-side, so undici's 300s
  *headers* timeout (`UND_ERR_HEADERS_TIMEOUT`) can fire before any byte arrives.
  The request "bugs out" even though the model is healthy and working.
- **No thinking visibility.** The non-stream `.response` read gives us no signal
  about how much reasoning the model did, making thinking-mode behaviour opaque.

## Goal

Replace the self-made HTTP call with the **official `ollama` npm library**, switch
to **streaming**, and **capture thinking output** for debug/metrics — while keeping
the provider's external contract (`generate({ system, prompt }) → string`) and the
error-message shape byte-identical so nothing downstream changes.

## Non-goals

- `openai.js` / Gemini stay on the OpenAI-compatible `fetch` path. The `ollama`
  library does not speak those protocols; reworking them is out of scope.
- No change to `tiered.js`, `config/index.js` env surface, the vote parser, or any
  agent runner. Thinking is captured internally, not threaded through `generate`.

## Approach

### Dependency

Add `ollama` (official client) to `package.json` dependencies. Used only by
`src/llm/ollama.js`.

### `createOllamaProvider` rewrite

Signature changes its injectable from `fetchImpl` to a client factory:

```js
export function createOllamaProvider(
  { url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1, options = null, think = null },
  clientFactory = (opts) => new Ollama(opts),
)
```

- Build the client once: `const client = clientFactory({ host: url })`.
- `doRequest` calls `client.generate({ model, system, prompt, stream: true, ...(options && { options }), ...(think != null && { think }) })`,
  which returns an **abortable async iterator**.
- Accumulate over the iterator: `chunk.response` → `answer`, `chunk.thinking` →
  `thinking`.
- **Per-request timeout:** `setTimeout(() => iterator.abort(), timeoutMs)`; clear
  on completion. Streaming means the first chunk arrives quickly, so a long
  *thinking* phase no longer trips a headers timeout — the abort timer now bounds
  total generation, our explicit budget rather than undici's hidden one.
- Return `{ text: answer, thinking }` from `doRequest` internally.
- `provider.generate` returns **`answer` (string)** — unchanged contract. On the
  way out it records the thinking metric and a debug log when thinking is present.

### Thinking capture

- New histogram in `src/instrumentation/metrics.js`:
  `legion_ollama_thinking_chars` — observed with `thinking.length` when non-empty.
  Buckets sized for character counts (e.g. `0, 100, 500, 1000, 2000, 5000, 10000`).
- `console.debug` one line with thinking length + model when thinking is present,
  so operators can confirm thinking mode is active without parsing metrics.

### Error mapping (preserve contract)

The `ollama` library surfaces errors differently from raw `fetch`:

- HTTP errors throw a `ResponseError` carrying `status_code` (and message).
- An abort (our timeout) throws an `AbortError`.
- Transport drops throw with a `cause` chain, same as `fetch`.

Adapt `isTimeout` / `isTransient` / `wrapError` to these shapes so the *emitted*
messages stay identical:

- Timeout → `Ollama request timed out after <timeoutMs>ms` (no retry).
- HTTP 5xx/429 → `Ollama request failed: <status>` and **is** retried; other
  statuses (4xx) not retried.
- Transport drop with cause → `Ollama request failed: <code>` and retried.

`createLimiter` (concurrency cap) and `retryAsync` (p-retry backoff) wrappers are
unchanged; only the predicates/wrapper they call adapt to the new error types.

### `provider.js`

`buildLocalProvider` stops threading `fetchImpl` into `createOllamaProvider`
(ollama provider builds its own client). `fetchImpl` is still passed for the
openai/gemini branches and the home-tier `/api/tags` readiness probe, which keeps
using `fetch` (fast, already tested, independent of the generate path).

## Testing

Rewrite `test/llm/ollama.test.js` to inject a fake `clientFactory` whose `generate`
returns an async-iterable of chunks and supports `.abort()`. Coverage:

- accumulates multi-chunk `response` into the returned string
- captures `thinking` chunks (metric observed / debug logged) and still returns
  only the final answer
- `think` field passthrough: omitted when null, `true`/`false` when set
- per-agent `options` (temperature, seed) passthrough
- `ResponseError` status → `Ollama request failed: <status>`; 5xx retried, 4xx not
- abort/timeout → `timed out` message, **not** retried
- transient transport error retried then succeeds
- concurrency cap: peak in-flight ≤ `maxConcurrent`

`test/llm/resolve-provider.test.js` and `test/llm/tiered.test.js` should still pass
unchanged (they assert `typeof generate === 'function'` / use stub providers).

## Docs

- New ADR documenting the switch to the official library + streaming and why
  (timeout-mid-thinking). Follows the existing ADR format validated by
  `test/docs/adr.test.js`.
- Cross-reference from ADR 0003 (inference abstraction).

## Risks

- **ollama-js abort API.** Exact method to cancel a streaming iterator
  (`iterator.abort()` vs `client.abort()`) must be confirmed against the installed
  version during implementation; the timeout test pins the chosen mechanism.
- **`system` placement.** `client.generate` takes `system` as a top-level field
  (same as the raw API); confirm the installed version accepts it.
