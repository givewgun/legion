# Ollama Provider on Official Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled `fetch` Ollama call with the official `ollama` npm client, switch to streaming, and capture thinking-mode output for metrics/debug — keeping the `generate({ system, prompt }) → string` contract and error-message shapes unchanged.

**Architecture:** `src/llm/ollama.js` builds an `Ollama` client (injectable factory for tests), calls `client.generate({ stream: true })`, accumulates `chunk.response` into the answer and `chunk.thinking` into a thinking buffer, and bounds total generation with an abort timer on the streaming iterator. Streaming makes the first byte arrive quickly so a long thinking phase no longer trips undici's 300s headers timeout. Thinking length is recorded to a new Prometheus histogram and a debug log; the provider still returns only the final answer string.

**Tech Stack:** Node ≥18 (ESM), `ollama` npm client, `prom-client`, `p-retry` (via `src/util/resilient.js`), Vitest.

## Global Constraints

- ESM modules (`type: "module"`); `const`/`let`, arrow callbacks, template literals.
- Provider contract is fixed: plain Ollama provider's `generate` returns a **string**. Do not change `tiered.js`, `provider.js` public signatures, `config/index.js` env surface, the vote parser, or any agent runner.
- Error messages must stay byte-identical to today: `Ollama request timed out after <timeoutMs>ms` (no retry) and `Ollama request failed: <status-or-code>`.
- Scope is the Ollama path only. Do **not** touch `openai.js`/Gemini.
- Never bypass commit hooks. Run `npm run lint` and the relevant tests before each commit.

---

### Task 1: Add the `ollama` dependency

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `package-lock.json` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `import { Ollama } from 'ollama'` available to later tasks.

- [ ] **Step 1: Install the official client**

Run: `npm install ollama`
Expected: `ollama` added under `dependencies` in `package.json`, `package-lock.json` updated.

- [ ] **Step 2: Verify it imports**

Run: `node -e "import('ollama').then(m => console.log(typeof m.Ollama))"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add official ollama client dependency"
```

---

### Task 2: Add the thinking-chars metric

**Files:**
- Modify: `src/instrumentation/metrics.js` (after `ollamaRequest`, ~line 59)
- Test: `test/instrumentation/metrics.test.js` (create)

**Interfaces:**
- Consumes: `prom-client` `register` (already set up in the file).
- Produces: `export const ollamaThinkingChars` — a `prom-client` Histogram named `legion_ollama_thinking_chars` with an `.observe(n)` method.

- [ ] **Step 1: Write the failing test**

Create `test/instrumentation/metrics.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { ollamaThinkingChars, register } from '../../src/instrumentation/metrics.js';

describe('ollamaThinkingChars metric', () => {
  it('is registered under the expected name and observes values', async () => {
    expect(typeof ollamaThinkingChars.observe).toBe('function');
    ollamaThinkingChars.observe(1234);
    const text = await register.metrics();
    expect(text).toContain('legion_ollama_thinking_chars');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/instrumentation/metrics.test.js`
Expected: FAIL — `ollamaThinkingChars` is `undefined` (no such export).

- [ ] **Step 3: Add the metric**

In `src/instrumentation/metrics.js`, immediately after the `ollamaRequest` histogram block, add:

```js
export const ollamaThinkingChars = new client.Histogram({
  name: 'legion_ollama_thinking_chars',
  help: 'Characters of thinking-mode reasoning emitted per Ollama generate',
  buckets: [0, 100, 500, 1000, 2000, 5000, 10000, 20000],
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/instrumentation/metrics.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/instrumentation/metrics.js test/instrumentation/metrics.test.js
git commit -m "feat: add ollama thinking-chars metric"
```

---

### Task 3: Rewrite `createOllamaProvider` on the official client + streaming

**Files:**
- Modify (full rewrite): `src/llm/ollama.js`
- Modify (full rewrite of test body): `test/llm/ollama.test.js`

**Interfaces:**
- Consumes: `Ollama` from `ollama` (Task 1); `ollamaThinkingChars` from `src/instrumentation/metrics.js` (Task 2); `createLimiter`, `retryAsync` from `src/util/resilient.js`; `ollamaRequest` from metrics.
- Produces: `createOllamaProvider(cfg, clientFactory = (opts) => new Ollama(opts))` → `{ name: 'local', model, generate({ system, prompt }) → Promise<string> }`. The second argument changes from `fetchImpl` to `clientFactory`. `clientFactory({ host })` must return an object with `generate(opts)` that, when `opts.stream === true`, resolves to an async-iterable yielding `{ response?, thinking? }` chunks and exposing `.abort()`.

- [ ] **Step 1: Write the failing tests (replace the file body)**

Replace the entire contents of `test/llm/ollama.test.js` with:

```js
import { describe, it, expect, vi } from 'vitest';
import { createOllamaProvider } from '../../src/llm/ollama.js';
import { createProvider } from '../../src/llm/provider.js';

// Build a fake streaming iterator from a list of chunks. abort() makes the
// in-progress `for await` reject with an AbortError on the next tick.
function makeStream(chunks) {
  let aborted = false;
  const iterator = (async function* () {
    for (const chunk of chunks) {
      if (aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield chunk;
    }
  })();
  iterator.abort = () => {
    aborted = true;
  };
  return iterator;
}

// A stream that never yields until aborted, then throws AbortError.
function makeHangingStream() {
  let abort;
  const gate = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });
  const iterator = (async function* () {
    await gate; // never resolves; only rejects on abort
  })();
  iterator.abort = abort;
  return iterator;
}

// Factory that records the generate options and returns a scripted stream.
function fakeClientFactory(impl) {
  const calls = [];
  const factory = (opts) => ({
    init: opts,
    generate: (genOpts) => {
      calls.push(genOpts);
      return impl(genOpts, calls.length);
    },
  });
  factory.calls = calls;
  return factory;
}

describe('createOllamaProvider (official client, streaming)', () => {
  it('accumulates multi-chunk response and returns the final answer string', async () => {
    const factory = fakeClientFactory(async () =>
      makeStream([{ response: 'BUY: ' }, { response: 'trend ' }, { response: 'up' }]),
    );
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'qwen2.5:7b-instruct' },
      factory,
    );
    const out = await provider.generate({ system: 'You are a trader', prompt: 'Rate NVDA' });
    expect(out).toBe('BUY: trend up');
    const gen = factory.calls[0];
    expect(gen.model).toBe('qwen2.5:7b-instruct');
    expect(gen.system).toBe('You are a trader');
    expect(gen.prompt).toBe('Rate NVDA');
    expect(gen.stream).toBe(true);
    expect(gen.options).toBeUndefined();
    expect(gen).not.toHaveProperty('think');
  });

  it('captures thinking chunks but still returns only the answer', async () => {
    const factory = fakeClientFactory(async () =>
      makeStream([
        { thinking: 'let me reason' },
        { thinking: ' some more' },
        { response: 'HOLD' },
      ]),
    );
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'gpt-oss:20b', think: true },
      factory,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('HOLD');
    expect(factory.calls[0].think).toBe(true);
  });

  it('omits the think field when not configured', async () => {
    const factory = fakeClientFactory(async () => makeStream([{ response: 'ok' }]));
    const provider = createOllamaProvider({ url: 'http://o:11434', model: 'm' }, factory);
    await provider.generate({ system: 's', prompt: 'p' });
    expect(factory.calls[0]).not.toHaveProperty('think');
  });

  it('includes think: false when configured', async () => {
    const factory = fakeClientFactory(async () => makeStream([{ response: 'ok' }]));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', think: false },
      factory,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    expect(factory.calls[0].think).toBe(false);
  });

  it('passes per-agent sampling options (temperature, seed)', async () => {
    const factory = fakeClientFactory(async () => makeStream([{ response: 'ok' }]));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', options: { temperature: 0.2, seed: 11 } },
      factory,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    expect(factory.calls[0].options).toEqual({ temperature: 0.2, seed: 11 });
  });

  it('maps a ResponseError status to "Ollama request failed: <status>"', async () => {
    const factory = fakeClientFactory(async () => {
      throw Object.assign(new Error('server error'), {
        name: 'ResponseError',
        status_code: 500,
      });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 0 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 500',
    );
  });

  it('does NOT retry a 400 ResponseError', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { name: 'ResponseError', status_code: 400 });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 3 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 400',
    );
    expect(calls).toBe(1);
  });

  it('retries a 503 ResponseError then succeeds', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('unavailable'), {
          name: 'ResponseError',
          status_code: 503,
        });
      }
      return makeStream([{ response: 'ok after retry' }]);
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      factory,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('ok after retry');
    expect(calls).toBe(2);
  });

  it('retries a transient transport error then succeeds', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return makeStream([{ response: 'recovered' }]);
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      factory,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('times out a hung stream and does NOT retry', async () => {
    let calls = 0;
    const factory = fakeClientFactory(() => {
      calls += 1;
      return makeHangingStream();
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', timeoutMs: 10, retries: 3, maxConcurrent: 1 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/i);
    expect(calls).toBe(1);
  });

  it('caps concurrency: peak in-flight <= maxConcurrent', async () => {
    let inFlight = 0;
    let peak = 0;
    const factory = fakeClientFactory(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return makeStream([{ response: 'ok' }]);
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', maxConcurrent: 1, retries: 0 },
      factory,
    );
    await Promise.all(
      Array.from({ length: 8 }, () => provider.generate({ system: 's', prompt: 'p' })),
    );
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe('createProvider', () => {
  it('builds an ollama provider by name', () => {
    const provider = createProvider('local', { ollama: { url: 'http://o:11434', model: 'm' } });
    expect(typeof provider.generate).toBe('function');
  });

  it('throws on an unknown provider name', () => {
    expect(() => createProvider('mystery', {})).toThrow('Unknown LLM provider: mystery');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/llm/ollama.test.js`
Expected: FAIL — current `ollama.js` uses `fetchImpl`/`/api/generate`, so the streaming/factory assertions fail.

- [ ] **Step 3: Rewrite `src/llm/ollama.js`**

Replace the entire file with:

```js
// Local LLM provider backed by the official `ollama` client, streaming.
// clientFactory is injectable for testing; defaults to a real Ollama client.
// Streaming makes the first chunk arrive quickly, so a long thinking-mode phase
// no longer trips undici's 300s headers timeout — our abort timer bounds total
// generation instead. thinking is captured for metrics/debug; generate still
// returns only the final answer string (unchanged contract).
import { Ollama } from 'ollama';
import { createLimiter, retryAsync } from '../util/resilient.js';
import { ollamaRequest, ollamaThinkingChars } from '../instrumentation/metrics.js';

// HTTP status carried by the lib's ResponseError; 5xx/429 are worth a retry.
const isRetryableStatus = (s) => s === 429 || (s >= 500 && s <= 599);

// An abort is our own timeout firing — the box is saturated, so never retry.
const isAbort = (err) => err.name === 'AbortError';

// Classify errors for retry decisions.
const isTransient = (err) => {
  if (isAbort(err)) return false; // timeout = saturated; retry would re-load it
  if (err.status_code != null) return isRetryableStatus(err.status_code);
  if (/Ollama request failed: (5\d\d|429)/.test(err.message)) return true;
  if (err.cause != null) return true; // transport drop with cause
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) return true;
  return false; // 4xx and other non-transient errors
};

// Wrap raw error into an informative error for callers (stable messages).
const wrapError = (err, timeoutMs) => {
  if (isAbort(err)) return new Error(`Ollama request timed out after ${timeoutMs}ms`);
  if (err.status_code != null) return new Error(`Ollama request failed: ${err.status_code}`);
  if (err.cause != null || /fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) {
    return new Error(
      `Ollama request failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`,
    );
  }
  return err; // already has the right message
};

export function createOllamaProvider(
  { url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1, options = null, think = null },
  clientFactory = (opts) => new Ollama(opts),
) {
  const client = clientFactory({ host: url });
  const limit = createLimiter(maxConcurrent);

  const doRequest = async ({ system, prompt }) => {
    // `options` carries per-agent sampling (temperature, seed) so agents sharing
    // one base model still sample decorrelated outputs. `think` is omitted when
    // null so a non-thinking model (qwen2.5) sees an unchanged request.
    const iterator = await client.generate({
      model,
      system,
      prompt,
      stream: true,
      ...(options && { options }),
      ...(think != null && { think }),
    });
    const timer = setTimeout(() => iterator.abort(), timeoutMs);
    let answer = '';
    let thinking = '';
    try {
      for await (const chunk of iterator) {
        if (chunk.response) answer += chunk.response;
        if (chunk.thinking) thinking += chunk.thinking;
      }
    } finally {
      clearTimeout(timer);
    }
    if (thinking) {
      ollamaThinkingChars.observe(thinking.length);
      console.debug(`[ollama] ${model} thinking: ${thinking.length} chars`);
    }
    return answer;
  };

  return {
    name: 'local',
    model,
    async generate({ system, prompt }) {
      // Measure end-to-end generate latency (incl. queue wait + retries).
      const stop = ollamaRequest.startTimer();
      try {
        return await limit(() =>
          retryAsync(() => doRequest({ system, prompt }), { retries, baseMs: 500, isTransient }),
        );
      } catch (err) {
        throw wrapError(err, timeoutMs);
      } finally {
        stop();
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llm/ollama.test.js`
Expected: PASS (all cases). If the abort case fails, confirm the installed `ollama` streaming iterator exposes `.abort()`; if it instead requires `client.abort()`, switch the timer to call `client.abort()` and re-run — pin whichever the lib provides.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: no errors. (`console.debug` is permitted; verify ESLint config does not flag it — if it does, the repo already uses `console.error` in metrics.js, so disable inline only if the rule fires.)

- [ ] **Step 6: Commit**

```bash
git add src/llm/ollama.js test/llm/ollama.test.js
git commit -m "feat: call Ollama via official client with streaming + thinking capture"
```

---

### Task 4: Stop threading `fetchImpl` into the Ollama provider

**Files:**
- Modify: `src/llm/provider.js:65-73` (`buildLocalProvider`)
- Test: `test/llm/resolve-provider.test.js` (run; should pass unchanged)

**Interfaces:**
- Consumes: `createOllamaProvider(cfg, clientFactory)` from Task 3.
- Produces: no signature change. `buildLocalProvider` calls `createOllamaProvider` with one argument (its config), letting the provider build its own client. `fetchImpl` is still used for the `/api/tags` readiness probe and the openai/gemini branches.

- [ ] **Step 1: Update `buildLocalProvider`**

In `src/llm/provider.js`, change the two `createOllamaProvider` calls to drop the `fetchImpl` argument (the probe and openai/gemini branches keep it):

```js
function buildLocalProvider(cfg, fetchImpl) {
  const oracle = createOllamaProvider(cfg.ollama);
  const home = cfg.home;
  if (!home?.url || home.enabled === false) return oracle;

  const pc = createOllamaProvider({
    ...cfg.ollama,
    url: home.url,
    model: home.model,
    think: home.think,
  });
  const probe = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), home.probeTimeoutMs);
    try {
      const res = await fetchImpl(`${home.url}/api/tags`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  return createTieredProvider({ primary: pc, fallback: oracle, probe });
}
```

- [ ] **Step 2: Run the provider tests**

Run: `npx vitest run test/llm/resolve-provider.test.js test/llm/tiered.test.js test/llm/ollama.test.js`
Expected: PASS. (Constructing a real `Ollama` client is offline — no network — so existing "builds a provider" assertions still hold.)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors (e.g. `fetchImpl` still referenced by the probe, so no unused-var).

- [ ] **Step 4: Commit**

```bash
git add src/llm/provider.js
git commit -m "refactor: ollama provider builds its own client; fetchImpl only for probe"
```

---

### Task 5: ADR + cross-reference

**Files:**
- Create: `docs/adr/0031-ollama-official-client.md`
- Modify: `docs/adr/0003-inference-abstraction.md` (add a one-line cross-ref under Decision)

**Interfaces:**
- Consumes: nothing.
- Produces: ADR following the required headings (`## Status`, `## Context`, `## Decision`, `## Alternatives considered`, `## Consequences`).

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0031-ollama-official-client.md`:

```markdown
# ADR 0031 — Ollama via the Official Client, Streaming

## Status
Accepted (2026-06-20).

## Context
`src/llm/ollama.js` hand-rolled the call: a `fetch` POST to `/api/generate` with
`stream: false`, reading `.response`. This works for small `qwen2.5` models but
breaks for the home-PC tier running `gpt-oss:20b` in thinking mode. A reasoning
model spends a long time on thinking tokens before the first answer byte; with a
buffered (non-stream) response, undici's 300s *headers* timeout
(`UND_ERR_HEADERS_TIMEOUT`) can fire before any byte arrives, so a healthy model
"bugs out". The non-stream read also gave no visibility into thinking activity.

## Decision
- Call Ollama through the official `ollama` npm client, with `stream: true`.
  Accumulate `chunk.response` into the answer and `chunk.thinking` into a thinking
  buffer. An abort timer on the streaming iterator bounds total generation — our
  explicit budget rather than undici's hidden headers timeout. The first chunk
  arrives quickly, so a long thinking phase no longer trips a read timeout.
- The provider still returns only the final answer string; the contract and the
  error-message shapes (`Ollama request failed: <status>`, `... timed out after
  <ms>ms`) are unchanged. Concurrency limiter and p-retry wrappers are kept.
- Thinking length is recorded to `legion_ollama_thinking_chars` and a debug log,
  giving operators a signal that thinking mode is active.

## Alternatives considered
- **Keep hand-rolled fetch, non-stream** — rejected: the headers-timeout-mid-
  thinking failure is intrinsic to buffering a slow reasoning response.
- **Hand-rolled fetch with manual SSE streaming** — rejected: re-implements what
  the official client already does (chunk framing, thinking field, abort).
- **Switch the whole provider layer (openai/gemini too)** — out of scope; the
  `ollama` client does not speak the OpenAI-compatible protocol those use.

## Consequences
- New runtime dependency (`ollama`); the openai/gemini path stays on `fetch`.
- The Ollama provider's injectable changes from `fetchImpl` to a `clientFactory`;
  `provider.js` no longer threads `fetchImpl` into it (still used by the readiness
  probe). See ADR 0003.
- Thinking-mode behaviour is now observable via the new metric.
```

- [ ] **Step 2: Cross-reference from ADR 0003**

In `docs/adr/0003-inference-abstraction.md`, append to the end of the `## Decision` section (after the existing paragraph):

```markdown

The `local` provider's transport is documented in ADR 0005 (serial inference) and
ADR 0031 (official `ollama` client + streaming).
```

- [ ] **Step 3: Verify ADR test still passes**

Run: `npx vitest run test/docs/adr.test.js`
Expected: PASS (the test validates ADRs 0001–0013; 0031 follows the same heading shape for consistency).

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0031-ollama-official-client.md docs/adr/0003-inference-abstraction.md
git commit -m "docs: ADR 0031 — Ollama via official client + streaming"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no regressions in llm, agents, emit, reliability, api).

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Confirm clean tree**

Run: `git status`
Expected: clean (everything committed).

---

## Self-Review

- **Spec coverage:** dependency (Task 1), streaming + thinking capture + error mapping + contract (Task 3), thinking metric (Task 2), `provider.js` fetchImpl cleanup (Task 4), ADR + cross-ref (Task 5), tests rewritten (Task 3), full verification (Task 6). All spec sections covered.
- **Placeholders:** none — every code/test step shows full content.
- **Type consistency:** `clientFactory({ host })` → `{ generate(opts) }` returning an abortable async-iterable of `{ response?, thinking? }`; `createOllamaProvider(cfg, clientFactory)`; `ollamaThinkingChars.observe(n)`. Names consistent across Tasks 2–4.
- **Risk pinned:** Task 3 Step 4 explicitly checks the abort mechanism (`iterator.abort()` vs `client.abort()`) against the installed lib.
