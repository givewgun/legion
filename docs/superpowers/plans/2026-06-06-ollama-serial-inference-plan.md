# Plan: serialize Ollama inference under concurrent-cycle load

Spec: [`docs/superpowers/specs/2026-06-06-ollama-serial-inference-design.md`](../specs/2026-06-06-ollama-serial-inference-design.md).
Approach **A** (Ollama serial + provider single-flight). Branch: `claude/legion-ollama-serial` (off main).
Execute with subagent-driven-development (TDD per task; spec + quality review each). Tasks are sequential (T2→T1, T3→T2).

## Context a future session needs (already verified)

- Wiring: `run/agent-*.js` call `createProvider(agentConfig.provider, cfg)`. `src/llm/provider.js`
  `createProvider('local', cfg)` → `createOllamaProvider(cfg.ollama, fetchImpl)`. So **`cfg.ollama`
  is the exact object passed to the provider** — adding fields to `loadConfig().ollama` makes them
  available to the provider with no plumbing changes.
- `loadConfig` ([src/config/index.js](../../../src/config/index.js)) has a `num(env,key,fallback)`
  helper and an `ollama: { url, model }` block. Tests: [test/config/index.test.js](../../../test/config/index.test.js).
- Provider today ([src/llm/ollama.js](../../../src/llm/ollama.js)): bare `fetch(/api/generate,{method:POST,
  body:{model,system,prompt,stream:false}})`, throws `Ollama request failed: ${status}` on !ok,
  returns `data.response`. Existing test: [test/llm/ollama.test.js](../../../test/llm/ollama.test.js).
  `fetchImpl` is injectable (2nd arg).
- Only the 4 voting agents call Ollama (emitter aggregates, risk is deterministic).
- `resolveProvider`/`defaultFactory` (per-cycle agent_config path) only forwards `model` (already
  drops `url`); **out of scope** — leave as-is, the live agents use `createProvider(name,cfg)`.
- Node global `fetch` is undici; it accepts a `dispatcher` option. Custom
  `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` disables undici's hidden 300s headers-timeout
  so our `AbortController` is the only deadline. Import: `import { Agent } from 'undici';` (undici is
  a transitive dep of Node; if not directly resolvable, fall back to a generous explicit
  `headersTimeout` via the same dispatcher, or document that NUM_PARALLEL=1 + shallow queue keeps
  waits < 300s — see Task 2 note).

## Task 1 — shared resilience helper (cheap model)

**Files:** new `src/util/resilient.js`, new `test/util/resilient.test.js`. TDD.

`createLimiter(max)` → `run(fn)`: ≤`max` active at once, FIFO queue, slot freed on settle (resolve
or reject), propagates value/error. Reference shape:
```js
export function createLimiter(max) {
  let active = 0; const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1; const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
```
`retryAsync(fn, { retries = 2, baseMs = 200, isTransient = () => true })`: await `fn()`; on throw, if
attempts remain AND `isTransient(err)` → `sleep(baseMs * 2 ** (attempt-1) + random*baseMs)` then retry;
else rethrow. Total attempts = `retries + 1`.

**Tests** (baseMs:1, real timers): limiter peak ≤ max under 8 concurrent (5ms fns), resolves with
value, rejects on reject; retryAsync retries-then-succeeds (throws 2×, retries:3 → called 3×), gives
up rethrowing last error (always throws, retries:2 → called 3×, /boom/), skips non-transient
(isTransient:()=>false → called 1×).

**Done:** vitest green, eslint clean, commit `feat(util): add resilient limiter + retry helper`.

## Task 2 — harden the Ollama provider (standard model)

**Files:** `src/llm/ollama.js`, `src/llm/provider.js` (pass opts through — likely already passes
`cfg.ollama` whole, verify), `test/llm/ollama.test.js` (extend). TDD.

`createOllamaProvider({ url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1 }, fetchImpl = fetch)`:
- module/provider-scoped `const limit = createLimiter(maxConcurrent)` from `../util/resilient.js`.
- `generate({system,prompt})` body wrapped: `return limit(() => retryAsync(doFetch, { retries, baseMs: 500, isTransient }))`.
- `doFetch`: AbortController with `setTimeout(abort, timeoutMs)` (clear in finally); call
  `fetchImpl(url+'/api/generate', { method, headers, body, signal, dispatcher })` where `dispatcher`
  is a single module/closure `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` (only attached for the
  real fetch path; injected stubs ignore extra option). Keep `stream:false`. On `!res.ok` throw
  `Error('Ollama request failed: ' + res.status)`. Return `data.response`.
- `isTransient(err)`: true for transport drops — `err.name !== 'AbortError'` AND (message includes
  `fetch failed`/`ECONNRESET`/`ECONNREFUSED`/`socket` OR a thrown 5xx-status marker). **AbortError
  (timeout) is NOT transient** → no retry. Non-2xx 4xx not transient.
- On final failure throw `Error('Ollama request failed: ' + cause)` where cause =
  `err.cause?.code || err.cause?.message || err.message` (surface real reason).

**Tests** (inject fetchImpl, small timeoutMs/baseMs): peak concurrent `generate` ≤ 1 (8 parallel,
counting fetchImpl); retries a transient `fetch failed` then succeeds; **times out** a hung fetch
(fetchImpl that only rejects on `signal` abort) with `timeoutMs:10, retries:0` → rejects, and assert
it was called once (no retry on timeout); happy path returns `data.response`; surfaces cause in
message. Keep existing passing assertions (adjust any `toHaveBeenCalledWith(url)` to allow a 2nd
options arg, e.g. `expect.anything()`).

**Note:** if `import { Agent } from 'undici'` is not resolvable in this Node/env, omit the dispatcher
and rely on `timeoutMs` + the shallow queue (NUM_PARALLEL=1 keeps waits < 300s at realistic
inference times); leave a comment. Don't block on it.

**Done:** vitest green, eslint clean, commit `fix(llm): bound + time-box + retry Ollama requests`.

## Task 3 — config wiring (cheap model)

**Files:** `src/config/index.js`, `test/config/index.test.js`. TDD.

Add to the `ollama` block in `loadConfig`: `timeoutMs: num(env,'OLLAMA_TIMEOUT_MS', 300000)` and
`maxConcurrent: num(env,'OLLAMA_MAX_CONCURRENT', 1)`. (These flow straight into the provider via the
existing `createOllamaProvider(cfg.ollama, …)` call.)

**Tests:** defaults when unset (300000, 1); parses overrides from a fake env; `num` throws on
non-numeric (reuse existing pattern).

**Done:** vitest green, eslint clean, commit `feat(config): add OLLAMA_TIMEOUT_MS + OLLAMA_MAX_CONCURRENT`.

## Task 4 — deploy config + docs (standard model, no tests)

Set on the **Ollama service/host** (not the app): `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=-1`.
- `docker-compose.yml` + `docker-compose.prod.yml`: add both env vars to the `ollama` service.
- `.github/workflows/ci.yml`: the prod-deploy `.env` heredoc — add `OLLAMA_NUM_PARALLEL=1`,
  `OLLAMA_KEEP_ALIVE=-1`, and `OLLAMA_TIMEOUT_MS` / `OLLAMA_MAX_CONCURRENT` if surfaced there.
- `.env.example`: document `OLLAMA_TIMEOUT_MS` (300000), `OLLAMA_MAX_CONCURRENT` (1),
  `OLLAMA_NUM_PARALLEL` (1), `OLLAMA_KEEP_ALIVE` (-1).
- Docs: `docs/RUNNING.md` (note serial inference + the 4 vars; update the "serialized through one
  Ollama" line in §4), `README.md` env table, `docs/DEPLOYMENT.md`. Update the troubleshooting row
  for `cycle error: fetch failed` to point at NUM_PARALLEL/queue, not just GunVest.

**Done:** `npx vitest run` full suite green, eslint clean, commit
`chore(deploy): run Ollama serial (NUM_PARALLEL=1, KEEP_ALIVE) + docs`.

## Follow-up (separate, after gunvest PR #10 merges)

Refactor `src/data/gunvest.js` to consume `src/util/resilient.js` (delete its inline limiter/retry)
so there is one implementation. Not in this plan.

## Verification (end to end, on the VM)

1. `OLLAMA_NUM_PARALLEL=1` + `OLLAMA_KEEP_ALIVE=-1` set on the ollama container; redeploy.
2. `curl -X POST localhost:8088/api/trigger` (sweep) — from the trigger-endpoint work — or
   `npm run scheduler -- --now`.
3. `docker logs legion-agent-news` / `-contrarian`: expect **no** `fetch failed`; votes arrive
   staggered over minutes; `htop` shows ~1 inference's worth of CPU at a time, not 4 cycles thrashing.
4. Any remaining abstain now reads `abstain (data fetch failed: <real cause>)`, not bare `fetch failed`.
