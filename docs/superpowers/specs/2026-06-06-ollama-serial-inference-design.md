# Design: serialize Ollama inference under concurrent-cycle load

**Date:** 2026-06-06
**Status:** approved (brainstorming) → ready for implementation plan

## Problem

On the Oracle A1 VM (4 ARM cores, CPU-only Ollama running `qwen2.5:7b`), every scheduled
sweep makes all four voting-agent processes gather their tickers and call Ollama at once. A
single 7B inference already pins all four cores, so when ~N tickers × 4 agents fire together
(~20 concurrent `/api/generate` calls) the box thrashes, most requests sit queued, and the
ones that wait past undici's hidden 300 s headers-timeout surface as:

```
[news] cycle error: fetch failed
[contrarian] cycle error: fetch failed
```

Each request succeeds in isolation (re-runs work), confirming the cause is **inference
contention**, not bad data. The provider ([src/llm/ollama.js](../../../src/llm/ollama.js)) does a
bare `fetch(/api/generate, { stream:false })` with **no timeout, no retry, no concurrency
cap**, so it offers no backpressure.

> Note: a sibling change (gunvest PR #10) bounds the *GunVest* client the same way. That fixes
> the data-fetch hop, not this LLM hop. This design is the Ollama-side counterpart and does not
> depend on #10 being merged.

## Goal / non-goals

- **Goal:** eliminate `fetch failed` from inference contention by running inference **strictly
  serial** (one at a time across the whole box) and bounding how many requests are submitted at
  once, so no request waits past its deadline.
- **Latency:** a fully serialized sweep may take tens of minutes; acceptable on a 4 h cadence.
- **Non-goals:** GPU/throughput scaling; multi-model routing; changing the consensus/emitter
  protocol; a durable cross-process queue (documented as the future "Approach B", not built).

## Chosen approach (A): Ollama serial + provider single-flight

Two layers:

1. **Ollama runs serial.** Set on the Ollama container:
   - `OLLAMA_NUM_PARALLEL=1` — execute exactly one inference at a time, each on all four cores
     (fastest per request, no core-splitting). This *is* the "strictly serial" guarantee.
   - `OLLAMA_KEEP_ALIVE=-1` — keep the model resident so it never reloads the ~5 GB weights
     between calls.

2. **Provider bounds submission + survives transients.** Each agent process holds **≤1**
   in-flight inference, so Ollama's queue never exceeds the number of agent processes (~4) and
   the deepest wait ≈ 3 × inference — comfortably under the deadline.

### Components

**`src/util/resilient.js`** (new) — small, dependency-free primitives, unit-tested in isolation:
- `createLimiter(max)` → `run(fn)`: bounded-concurrency gate (queued FIFO, slot released on
  settle).
- `retryAsync(fn, { retries, baseMs, isTransient })`: retry with jittered exponential backoff;
  only retries when `isTransient(err)` is true; rethrows otherwise.

**`src/llm/ollama.js`** (modified) — `createOllamaProvider({ url, model, timeoutMs, retries, maxConcurrent }, fetchImpl)`:
- a provider-scoped `createLimiter(maxConcurrent)` (default **1**) wraps `generate`.
- `generate` issues the POST through an `AbortController` deadline (`timeoutMs`, default
  **300000**) and a custom undici dispatcher `new Agent({ headersTimeout: 0, bodyTimeout: 0 })`
  passed as the `dispatcher` fetch option, so **our** timeout is the only deadline (undici's
  300 s headers-timeout cannot pre-empt a legitimately-queued request). Keeps `stream:false`.
- wrapped in `retryAsync` whose `isTransient` matches transport drops (`fetch failed` /
  ECONNRESET / ECONNREFUSED / socket) and retryable 5xx — but **not** `AbortError` (a timeout
  means the box is genuinely saturated; retrying re-loads it → let the agent abstain).
- on failure throws `Ollama request failed: <cause>` (cause surfaced from `err.cause`), so the
  factory's existing catch records `abstain (data fetch failed: …)` with a real reason.
- The dispatcher is only attached to the real `fetch`; injected `fetchImpl` stubs ignore it.

**Config / deploy:**
- `src/config/index.js`: read `OLLAMA_TIMEOUT_MS` (default 300000) and `OLLAMA_MAX_CONCURRENT`
  (default 1) into the ollama config block; thread through `createProvider` /
  `createOllamaProvider`.
- `docker-compose.yml`, `docker-compose.prod.yml`, the CI deploy `.env` heredoc
  (`.github/workflows/ci.yml`): set `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_KEEP_ALIVE=-1` on the
  Ollama service/host.
- `.env.example`: document `OLLAMA_TIMEOUT_MS`, `OLLAMA_MAX_CONCURRENT`, and the two Ollama
  server vars.

### Data flow

```
handleCycle → gather(gunvest)        (outside the LLM limiter; overlaps the prior inference)
            → provider.generate      → limiter(1) → retryAsync → fetch(/api/generate,
                                                                  AbortController, dispatcher)
            → parse → publish vote
```

Across the box: ≤4 requests ever queued at Ollama; `NUM_PARALLEL=1` executes exactly one at a
time. Only the four voting agents call Ollama (emitter aggregates; risk is deterministic).

### Error handling

| Case | Behaviour |
| --- | --- |
| transient transport / retryable 5xx | `retryAsync` backs off and retries; on exhaustion → throw with cause → agent abstains |
| timeout (AbortController) | **no retry** → abstain (box saturated) |
| non-transient (e.g. 400 bad model) | fail fast → abstain |
| agent slow but eventually returns | publishes its vote late; emitter still collects 4 votes per round (staggered). Per-round watchdog = future hardening, not built |

### Testing (TDD)

- `resilient.js`: limiter peak ≤ max under a burst; `retryAsync` retries-then-succeeds, gives
  up and surfaces cause, and does not retry a non-transient error.
- `ollama.js`: peak concurrent `generate` ≤ 1; retries a transient `fetch failed`; times out a
  hung request and does **not** retry it; surfaces `err.cause`; happy path returns
  `data.response`.
- `config`: env vars map to the expected provider options (defaults when unset).

All tests use the injected `fetchImpl` (no network, no real Ollama).

## Scope

- **New:** `src/util/resilient.js` + `test/util/resilient.test.js`; `test/llm/ollama.test.js`
  cases for the new behaviour.
- **Modified:** `src/llm/ollama.js`, `src/llm/provider.js` (pass opts), `src/config/index.js`,
  `.env.example`, `docker-compose.yml`, `docker-compose.prod.yml`,
  `.github/workflows/ci.yml`, docs (`RUNNING.md`, `README.md`, `DEPLOYMENT.md`).
- **Follow-up (not in this change):** once gunvest PR #10 merges, refactor
  `src/data/gunvest.js` to consume `resilient.js` and delete its inline limiter/retry — one
  implementation. Tracked, not blocking.

## Approach B — documented upgrade path (not built)

If a durable/observable queue or multi-worker scaling is ever wanted: introduce a NATS
inference-worker. Agents stop calling Ollama directly; their provider becomes a NATS
request-reply client publishing `{ system, prompt }` to subject `llm.generate` (queue group
`llm`). A new `src/run/llm-worker.js` process owns the only Ollama client and drains the group
serially; **global concurrency = number of workers (K)**. Migration is a provider swap plus one
new process + compose service. Today's `OLLAMA_NUM_PARALLEL=1` already delivers the serial
guarantee, so this stays deferred (YAGNI).
