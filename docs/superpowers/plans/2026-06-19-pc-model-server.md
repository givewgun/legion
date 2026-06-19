# PC Model Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Legion's LLM calls to a home PC running `gpt-oss:20b` when it is awake, ready, and not busy — falling back to the Oracle VM's `qwen2.5:7b` otherwise — and segment learned reliability per `(agent, model)` so each model earns its own track record.

**Architecture:** The existing `local` provider becomes a *tiered* provider: a fast health-gated probe of a PC-side readiness sidecar decides per request whether to call the PC's Ollama (primary) or Oracle's Ollama (fallback); any PC error fails over to Oracle. The served model name rides each vote through NATS → emitter → `signal_votes.model`. The reliability learner buckets, stores, and applies its dials keyed by `(agent_id, model)`. A dashboard toggle (persisted in a new `runtime_config` table) is a global kill switch layered on top of the automatic busy-check. PC wake/prime/sleep and Tailscale/sidecar setup are operator infrastructure documented as a runbook (final task), not code.

**Tech Stack:** Node 18+ ES modules, Vitest, Express, node-postgres, NATS, Ollama HTTP API, React (web dashboard), Tailscale.

## Global Constraints

- ES modules with import/export (`type: "module"`); `const`/`let`, arrow callbacks, async/await; template literals.
- Tests: Vitest, idiomatic `expect/toBe/toEqual`; mock as little as possible (inject `fetchImpl`/`repo`); `vi.spyOn` + `vi.restoreAllMocks()` in `afterEach`, never global `vi.mock()`.
- One test file per component (e.g. all tiered-provider tests in `test/llm/tiered.test.js`).
- Conventional Commits. Do NOT bypass git hooks. Do NOT commit unless a step says to.
- Provider `generate({ system, prompt })` contract: **plain providers return a `string`; the tiered provider returns `{ text, model }`.** All model-aware call sites normalize via `normalizeGenerate` (Task 4).
- Backwards compatibility is mandatory: with `HOME_OLLAMA_URL` unset, behavior must be byte-identical to today (pure Oracle, no probe, no extra request fields).
- Served-model string = the Ollama model name actually used (`HOME_MODEL` when the PC served, `OLLAMA_MODEL` when Oracle served).
- Legacy `signal_votes` rows backfill `model` to the current Oracle model (`OLLAMA_MODEL` default `qwen2.5:7b-instruct`).
- Cold-start: a new `(agent, model)` with `< MIN_RESOLVED` resolved forecasts stays at ρ = 1.0 (existing `reliabilityFromBrier`/`informationFactor`/`calibrationFromSamples` already enforce this — do not change it).

---

## File Structure

**Create:**
- `src/llm/tiered.js` — tiered provider (health-gated PC-primary, Oracle-fallback, reports served model).
- `test/llm/tiered.test.js` — tiered provider tests.
- `src/api/routes/settings.js` — GET/PUT global runtime flags (home-PC toggle).
- `test/api/settings.test.js` — settings route tests.
- `docs/RUNBOOK-pc-model-server.md` — operator runbook (Tailscale, PC Ollama, sidecar, wake/prime/sleep, verification).

**Modify:**
- `src/config/index.js` — add `home` config block.
- `src/llm/provider.js` — build tiered provider for `local` when home configured + enabled; add `normalizeGenerate` + `MODEL_KEY` helpers; thread `home.enabled`.
- `src/agents/get-provider.js` — read global home-PC toggle per cycle, overlay `home.enabled` into cfg.
- `src/agents/factory.js` — normalize generate result, capture served model, tag vote.
- `src/consensus/vote.js` — `createVote` carries optional `model`.
- `src/agents/parse.js` — `parseVote` passes `model` into the vote.
- `src/reliability/reflect.js` — normalize generate result (text-only).
- `src/consensus/reliability.js` — `scaleWeights`/`scaleConviction` look up by `(agentId, model)`.
- `src/emit/emitter.js` — load per-`(agent, model)` dial maps; persist `model` in signal votes.
- `src/reliability/update.js` — bucket + persist dials by `(agent, model)`.
- `src/db/schema.sql` — `signal_votes.model`; re-key `agent_reliability` + `agent_regime_reliability` by `(agent_id, model)`; `runtime_config` table.
- `src/db/repo.js` — `addSignalVotes` model; reliability getters/upserts keyed by model; `getResolvedForecasts`/`getAgentBoardRows` select model; `getHomePcEnabled`/`setHomePcEnabled`.
- `web/src/api/client.js` — `getSettings`/`setSettings`.
- `web/src/pages/AgentConfig.jsx` — global "Use home PC model" toggle.

---

## Task 1: Config — `home` block

**Files:**
- Modify: `src/config/index.js`
- Test: `test/config/index.test.js`

**Interfaces:**
- Produces: `cfg.home = { url, model, think, probeTimeoutMs, enabled }`. `url` is `''` when unset (→ home tier disabled). `think` uses the existing tri-state `bool()`. `enabled` defaults `true` (the global toggle overrides at runtime, Task 10).

- [ ] **Step 1: Write the failing test**

Add to `test/config/index.test.js`:

```javascript
it('defaults the home block to disabled (empty url) and gpt-oss:20b', () => {
  const cfg = loadConfig({});
  expect(cfg.home).toEqual({
    url: '',
    model: 'gpt-oss:20b',
    think: null,
    probeTimeoutMs: 1500,
    enabled: true,
  });
});

it('reads home overrides from env', () => {
  const cfg = loadConfig({
    HOME_OLLAMA_URL: 'http://100.64.0.2:11434',
    HOME_MODEL: 'qwen3:14b',
    HOME_THINK: 'false',
    HOME_PROBE_TIMEOUT_MS: '2000',
  });
  expect(cfg.home).toEqual({
    url: 'http://100.64.0.2:11434',
    model: 'qwen3:14b',
    think: false,
    probeTimeoutMs: 2000,
    enabled: true,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config/index.test.js`
Expected: FAIL — `cfg.home` is undefined.

- [ ] **Step 3: Implement the config block**

In `src/config/index.js`, inside the returned object (after the `gemini` block), add:

```javascript
    // Home PC model server (the tiered `local` primary tier). An empty url means
    // unconfigured: the `local` provider stays pure-Oracle, byte-identical to before.
    // `enabled` is the static default; the dashboard toggle (runtime_config) overrides
    // it per cycle. `probeTimeoutMs` bounds the readiness-sidecar health probe so a
    // sleeping PC fails fast to Oracle instead of hanging the cycle.
    home: {
      url: env.HOME_OLLAMA_URL || '',
      model: env.HOME_MODEL || 'gpt-oss:20b',
      think: bool(env, 'HOME_THINK'),
      probeTimeoutMs: num(env, 'HOME_PROBE_TIMEOUT_MS', 1500),
      enabled: true,
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config/index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.js test/config/index.test.js
git commit -m "feat: add home PC model server config block"
```

---

## Task 2: Tiered provider

**Files:**
- Create: `src/llm/tiered.js`
- Test: `test/llm/tiered.test.js`

**Interfaces:**
- Consumes: two provider instances each exposing `generate({system,prompt}) -> string` and a `.model` string (the Ollama/openai providers already hold their model — Task 3 attaches `.model`).
- Produces: `createTieredProvider({ primary, fallback, probe, isEnabled }) -> { name: 'local', model, generate({system,prompt}) -> { text, model } }` where:
  - `probe: () => Promise<boolean>` — readiness check for the PC (sidecar). Defaults to always-false if omitted.
  - `isEnabled: () => boolean | Promise<boolean>` — global toggle gate. Defaults to `() => true`.
  - `generate` returns `{ text, model }`: uses `primary` when `isEnabled()` AND `probe()` both pass; on a primary throw, falls back to `fallback`; when the gate/probe is not satisfied, calls `fallback` directly. `model` is the served provider's `.model`.
  - `.model` getter returns the primary's model (advertised default).

- [ ] **Step 1: Write the failing test**

Create `test/llm/tiered.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { createTieredProvider } from '../../src/llm/tiered.js';

const stub = (model, impl) => ({
  name: 'local',
  model,
  generate: vi.fn(impl ?? (async () => `from-${model}`)),
});

describe('createTieredProvider', () => {
  it('routes to the primary when enabled and probe is ready', async () => {
    const primary = stub('gpt-oss:20b');
    const fallback = stub('qwen2.5:7b-instruct');
    const t = createTieredProvider({
      primary,
      fallback,
      probe: async () => true,
      isEnabled: () => true,
    });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-gpt-oss:20b', model: 'gpt-oss:20b' });
    expect(fallback.generate).not.toHaveBeenCalled();
  });

  it('routes to the fallback when the probe is not ready', async () => {
    const primary = stub('gpt-oss:20b');
    const fallback = stub('qwen2.5:7b-instruct');
    const t = createTieredProvider({ primary, fallback, probe: async () => false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' });
    expect(primary.generate).not.toHaveBeenCalled();
  });

  it('routes to the fallback when the global toggle is off (no probe)', async () => {
    const primary = stub('gpt-oss:20b');
    const fallback = stub('qwen2.5:7b-instruct');
    const probe = vi.fn(async () => true);
    const t = createTieredProvider({ primary, fallback, probe, isEnabled: () => false });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out.model).toBe('qwen2.5:7b-instruct');
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails over to the fallback when the primary throws mid-call', async () => {
    const primary = stub('gpt-oss:20b', async () => {
      throw new Error('Ollama request timed out after 1500ms');
    });
    const fallback = stub('qwen2.5:7b-instruct');
    const t = createTieredProvider({ primary, fallback, probe: async () => true });
    const out = await t.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct' });
  });

  it('advertises the primary model as .model', () => {
    const t = createTieredProvider({ primary: stub('gpt-oss:20b'), fallback: stub('x') });
    expect(t.model).toBe('gpt-oss:20b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/llm/tiered.test.js`
Expected: FAIL — cannot import `createTieredProvider`.

- [ ] **Step 3: Implement the tiered provider**

Create `src/llm/tiered.js`:

```javascript
// Tiered `local` provider: prefer the home PC's Ollama (primary) when the global
// toggle is on AND a fast readiness probe passes, else use the Oracle VM's Ollama
// (fallback). Any primary error fails over to the fallback so a PC that sleeps
// mid-sweep degrades gracefully. generate returns { text, model } so the served
// model can be tagged onto the vote for per-(agent, model) reliability.
export function createTieredProvider({
  primary,
  fallback,
  probe = async () => false,
  isEnabled = () => true,
}) {
  async function usePrimary() {
    if (!(await isEnabled())) return false;
    try {
      return await probe();
    } catch {
      return false; // probe failure == not ready
    }
  }

  return {
    name: 'local',
    get model() {
      return primary.model;
    },
    async generate({ system, prompt }) {
      if (await usePrimary()) {
        try {
          const text = await primary.generate({ system, prompt });
          return { text, model: primary.model };
        } catch {
          // primary errored (timeout / transport / 5xx after its own retries) —
          // fail this call over to the always-available fallback.
        }
      }
      const text = await fallback.generate({ system, prompt });
      return { text, model: fallback.model };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/llm/tiered.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/llm/tiered.js test/llm/tiered.test.js
git commit -m "feat: tiered local provider (PC primary, Oracle fallback)"
```

---

## Task 3: Wire tiered into `createProvider` + provider helpers

**Files:**
- Modify: `src/llm/provider.js`
- Modify: `src/llm/ollama.js` (expose `.model`)
- Modify: `src/llm/openai.js` (expose `.model`)
- Test: `test/llm/resolve-provider.test.js`

**Interfaces:**
- Consumes: `cfg.home`, `cfg.ollama` (Task 1); `createTieredProvider` (Task 2).
- Produces:
  - `createProvider('local', cfg, fetchImpl)` returns a tiered provider when `cfg.home?.url` is non-empty AND `cfg.home.enabled !== false`; otherwise the plain Ollama provider (unchanged).
  - The PC tier uses `cfg.home.url/model/think/probeTimeoutMs`; the probe does `GET {home.url}/api/tags` with an `AbortController(home.probeTimeoutMs)`, returning `res.ok`.
  - `export async function normalizeGenerate(provider, args) -> { text, model }` — calls `provider.generate(args)`; if the result is a string, wraps it as `{ text: result, model: provider.model ?? null }`; if it is `{ text, model }`, returns it as-is.
  - `export function modelKey(agentId, model) -> string` = `` `${agentId} ${model}` `` — the composite key for per-`(agent, model)` dial maps (Tasks 6–9).
- Ollama/OpenAI providers gain a `model` property equal to their configured model.

- [ ] **Step 1: Write the failing test**

Add to `test/llm/resolve-provider.test.js`:

```javascript
import { createProvider, normalizeGenerate, modelKey } from '../../src/llm/provider.js';

describe('tiered local wiring', () => {
  const baseCfg = {
    ollama: { url: 'http://oracle:11434', model: 'qwen2.5:7b-instruct' },
    home: { url: '', model: 'gpt-oss:20b', think: null, probeTimeoutMs: 1500, enabled: true },
  };

  it('returns a plain ollama provider (string generate) when home url is empty', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'hi' }) }));
    const p = createProvider('local', baseCfg, fetchImpl);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('hi'); // plain string contract preserved
    expect(p.model).toBe('qwen2.5:7b-instruct');
  });

  it('returns a tiered provider when home url is set and enabled', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434' } };
    // probe (GET /api/tags) ready, primary generate returns text
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({ response: 'from-pc' }) };
    });
    const p = createProvider('local', cfg, fetchImpl);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out).toEqual({ text: 'from-pc', model: 'gpt-oss:20b' });
  });

  it('stays pure-Oracle when home.enabled is false even if url set', async () => {
    const cfg = { ...baseCfg, home: { ...baseCfg.home, url: 'http://pc:11434', enabled: false } };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'oracle' }) }));
    const p = createProvider('local', cfg, fetchImpl);
    const out = await p.generate({ system: 's', prompt: 'p' });
    expect(out.model).toBe('qwen2.5:7b-instruct');
  });
});

describe('normalizeGenerate', () => {
  it('wraps a string result with the provider model', async () => {
    const provider = { model: 'm', generate: async () => 'txt' };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 'txt', model: 'm' });
  });
  it('passes through an object result', async () => {
    const provider = { model: 'm', generate: async () => ({ text: 't', model: 'pc' }) };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 't', model: 'pc' });
  });
});

describe('modelKey', () => {
  it('joins agent and model with a NUL separator', () => {
    expect(modelKey('news', 'gpt-oss:20b')).toBe('news gpt-oss:20b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/llm/resolve-provider.test.js`
Expected: FAIL — `normalizeGenerate`/`modelKey` undefined; tiered branch absent.

- [ ] **Step 3: Expose `.model` on the plain providers**

In `src/llm/ollama.js`, change the returned object so `model` is a property:

```javascript
  return {
    name: 'local',
    model,
    async generate({ system, prompt }) {
```

In `src/llm/openai.js`, likewise:

```javascript
  return {
    name,
    model,
    async generate({ system, prompt }) {
```

- [ ] **Step 4: Implement the tiered wiring + helpers in `provider.js`**

In `src/llm/provider.js`, add the import at the top:

```javascript
import { createTieredProvider } from './tiered.js';
```

Replace the `case 'local':` line in `createProvider` with a call to a helper, and add the helper + exports:

```javascript
    case 'local':
      return buildLocalProvider(cfg, fetchImpl);
```

```javascript
// The `local` provider is tiered when a home PC URL is configured AND not disabled:
// primary = PC Ollama (cfg.home), fallback = Oracle Ollama (cfg.ollama). Otherwise it
// is the plain Oracle Ollama provider — byte-identical to before this feature.
function buildLocalProvider(cfg, fetchImpl) {
  const oracle = createOllamaProvider(cfg.ollama, fetchImpl);
  const home = cfg.home;
  if (!home?.url || home.enabled === false) return oracle;

  const pc = createOllamaProvider(
    { ...cfg.ollama, url: home.url, model: home.model, think: home.think },
    fetchImpl,
  );
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

// Normalizes the provider generate contract: plain providers return a string,
// the tiered provider returns { text, model }. Callers that need the served model
// (the agent runner) use this; text-only callers read `.text`.
export async function normalizeGenerate(provider, args) {
  const out = await provider.generate(args);
  if (typeof out === 'string') return { text: out, model: provider.model ?? null };
  return out;
}

// Composite key for per-(agent, model) reliability dial maps. NUL never appears in
// an agent id or an Ollama model name, so it is a safe, reversible separator.
export function modelKey(agentId, model) {
  return `${agentId} ${model}`;
}
```

Note: the readiness probe here hits `/api/tags` directly. The PC-side readiness sidecar (runbook, Task 11) is reached by pointing `HOME_OLLAMA_URL`'s probe at the sidecar; for v1 the sidecar proxies/【gates】 `/api/tags`. Keeping the probe on `/api/tags` keeps the legion code sidecar-agnostic — see the runbook for how the sidecar makes `/api/tags` reflect busy state.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/llm/resolve-provider.test.js test/llm/ollama.test.js`
Expected: PASS. (If `ollama.test.js` asserts the returned object shape, the added `model` property is additive and should not break `toMatchObject`/method tests; if a test uses `toEqual` on the whole provider object, update it to include `model`.)

- [ ] **Step 6: Commit**

```bash
git add src/llm/provider.js src/llm/ollama.js src/llm/openai.js test/llm/resolve-provider.test.js
git commit -m "feat: build tiered local provider + generate/model helpers"
```

---

## Task 4: Tag votes with the served model

**Files:**
- Modify: `src/consensus/vote.js`
- Modify: `src/agents/parse.js`
- Modify: `src/agents/factory.js`
- Modify: `src/reliability/reflect.js`
- Test: `test/agents/parse.test.js` (or the existing parse test file), `test/agents/factory.test.js`

**Interfaces:**
- Consumes: `normalizeGenerate` (Task 3).
- Produces:
  - `createVote({ agentId, stance, conviction, weight, rationale, model })` — vote object gains `model` (default `null`). `validateVote` is unchanged (model is optional metadata, not validated).
  - `parseVote(text, { agentId, weight, model })` — sets `vote.model = model ?? null`.
  - `factory.handleCycle` calls `normalizeGenerate(activeProvider, {...})`, uses `.text` for parsing and passes `.model` into `parseVote` and into `abstain`. Vote objects published to NATS now carry `model`.

- [ ] **Step 1: Write the failing test**

Add to the parse test file:

```javascript
it('tags the vote with the served model', () => {
  const text = '{"stance": 1, "conviction": 0.7, "rationale": "ok"}';
  const { ok, vote } = parseVote(text, { agentId: 'news', weight: 1.2, model: 'gpt-oss:20b' });
  expect(ok).toBe(true);
  expect(vote.model).toBe('gpt-oss:20b');
});

it('defaults model to null when not supplied', () => {
  const { vote } = parseVote('{"stance":0,"conviction":0,"rationale":"x"}', {
    agentId: 'news',
    weight: 1,
  });
  expect(vote.model).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/parse.test.js`
Expected: FAIL — `vote.model` is undefined.

- [ ] **Step 3: Implement model tagging**

`src/consensus/vote.js`:

```javascript
export function createVote({ agentId, stance, conviction, weight, rationale, model = null }) {
  return { agentId, stance, conviction, weight, rationale, model };
}
```

`src/agents/parse.js` — extend the signature and the `createVote` call:

```javascript
export function parseVote(text, { agentId, weight, model = null }) {
  const obj = extractJson(text);
  if (!obj) return { ok: false, vote: null, errors: ['no JSON object found in LLM output'] };

  const vote = createVote({
    agentId,
    stance: obj.stance,
    conviction: obj.conviction,
    weight,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    model,
  });

  const { ok, errors } = validateVote(vote);
  return { ok, vote: ok ? vote : null, errors };
}
```

`src/agents/factory.js` — import the normalizer and thread the model:

```javascript
import { normalizeGenerate } from '../llm/provider.js';
```

Replace the generate + parse block (around lines 82–98) with:

```javascript
      const stopInference = agentInference.startTimer({ agent: id });
      let text;
      let servedModel = null;
      try {
        const out = await normalizeGenerate(activeProvider, {
          system,
          prompt: memory ? `${memory}\n\n${prompt}` : prompt,
        });
        text = out.text;
        servedModel = out.model;
      } finally {
        stopInference();
      }
      const parsed = parseVote(text, { agentId: id, weight, model: servedModel });
      if (parsed.ok) {
        vote = parsed.vote;
      } else {
        logger.warn(`[${id}] parse failed: ${parsed.errors.join('; ')}`);
        vote = abstain(id, weight, 'unparseable vote', servedModel);
      }
```

Update the `abstain` helper signature so model is carried (abstentions on failover are still attributed):

```javascript
function abstain(id, weight, reason, model = null) {
  return createVote({
    agentId: id,
    stance: 0,
    conviction: 0,
    weight,
    rationale: `abstain (${reason})`,
    model,
  });
}
```

`src/reliability/reflect.js` — find each `provider.generate(...)` / `await provider.generate` call and read text-only via the normalizer. Add the import:

```javascript
import { normalizeGenerate } from '../llm/provider.js';
```

and replace the call site(s) `const text = await provider.generate(args);` with:

```javascript
const { text } = await normalizeGenerate(provider, args);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agents/ test/reliability/reflect.test.js`
Expected: PASS. Fix any factory/reflect test that asserted a string generate result by switching the mock to return a string (still valid — `normalizeGenerate` wraps it) or by asserting on `vote.model`.

- [ ] **Step 5: Commit**

```bash
git add src/consensus/vote.js src/agents/parse.js src/agents/factory.js src/reliability/reflect.js test/
git commit -m "feat: tag each vote with the model that produced it"
```

---

## Task 5: Schema — `signal_votes.model`, re-keyed reliability tables, `runtime_config`

**Files:**
- Modify: `src/db/schema.sql`
- Test: `test/db/schema-migration.test.js` (create if absent; otherwise add to the existing schema/repo test). If the suite has no DB-backed test harness, this task's verification is the idempotent re-run in Step 4 against a local Postgres.

**Interfaces:**
- Produces:
  - `legion.signal_votes.model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct'`.
  - `legion.agent_reliability` PK becomes `(agent_id, model)` with `model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct'`.
  - `legion.agent_regime_reliability` PK becomes `(agent_id, regime, model)` with the same `model` column/default.
  - `legion.runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
- The default value backfills all existing rows to the Oracle model in one idempotent migration pass.

- [ ] **Step 1: Write the migration SQL (idempotent, appended to `schema.sql`)**

Append to `src/db/schema.sql`:

```sql
-- ── PC model server: per-(agent, model) reliability segmentation ──────────────
-- The served model is tagged on every signal vote so the learner can earn a
-- separate track record per model. Existing rows backfill to the Oracle model
-- (the only model that produced them) via the column default.
ALTER TABLE legion.signal_votes
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct';

ALTER TABLE legion.agent_reliability
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct';
ALTER TABLE legion.agent_regime_reliability
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct';

-- Re-key the dial tables to include model. Guarded so re-running the schema is a
-- no-op once the composite key is in place.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_reliability_pkey'
       AND (SELECT array_length(conkey, 1) FROM pg_constraint
             WHERE conname = 'agent_reliability_pkey') = 1
  ) THEN
    ALTER TABLE legion.agent_reliability DROP CONSTRAINT agent_reliability_pkey;
    ALTER TABLE legion.agent_reliability ADD PRIMARY KEY (agent_id, model);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_regime_reliability_pkey'
       AND (SELECT array_length(conkey, 1) FROM pg_constraint
             WHERE conname = 'agent_regime_reliability_pkey') = 2
  ) THEN
    ALTER TABLE legion.agent_regime_reliability DROP CONSTRAINT agent_regime_reliability_pkey;
    ALTER TABLE legion.agent_regime_reliability ADD PRIMARY KEY (agent_id, regime, model);
  END IF;
END $$;

-- Global runtime flags editable from the dashboard (e.g. the home-PC kill switch).
CREATE TABLE IF NOT EXISTS legion.runtime_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Note for the implementer: verify the actual PK constraint names in your DB (`\d legion.agent_reliability`). If `agent_regime_reliability` currently has a different PK arity than 2, adjust the `array_length(...) = N` guard to match the existing key before this migration runs.

- [ ] **Step 2: Run the migration against a local Postgres**

Run: `npm run db:migrate`
Expected: `legion schema migrated`, no error.

- [ ] **Step 3: Run it again (idempotency check)**

Run: `npm run db:migrate`
Expected: `legion schema migrated` again — the `DO $$` guards make the PK swap a no-op.

- [ ] **Step 4: Verify columns/keys (psql)**

Run: `psql "$DATABASE_URL" -c "\d legion.agent_reliability" -c "\d legion.signal_votes" -c "\d legion.runtime_config"`
Expected: `agent_reliability` PK = `(agent_id, model)`; `signal_votes` has a `model` column NOT NULL default `qwen2.5:7b-instruct`; `runtime_config` exists.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql test/db/
git commit -m "feat: segment reliability schema by model; add runtime_config"
```

---

## Task 6: Repo — persist + read model in votes and dials

**Files:**
- Modify: `src/db/repo.js`
- Test: `test/db/repo.test.js` (add cases; if repo tests are DB-backed and unavailable, assert query text via the existing repo test pattern).

**Interfaces:**
- Consumes: `modelKey` (Task 3) is NOT used in the repo — the repo returns nested maps `{ [agentId]: { [model]: value } }` and the emitter composes keys.
- Produces (changed/added repo methods):
  - `addSignalVotes(signalId, votes)` — inserts `model` (6 columns); each `v.model` defaults to `'qwen2.5:7b-instruct'` when null.
  - `getAllReliability()` → `{ [agentId]: { [model]: rho } }` (nested).
  - `getAgentCalibration()` / `getAgentInfoFactors()` → nested `{ [agentId]: { [model]: value } }`.
  - `getRegimeReliability(regime)` / `getRegimeCalibration(regime)` → nested `{ [agentId]: { [model]: value } }`.
  - `getFlooredStreaks()` → `{ [agentId]: { [model]: streak } }`.
  - `upsertReliability(agentId, model, rho, sampleSize, calibration, infoFactor)`.
  - `upsertRegimeReliability(agentId, regime, model, rho, sampleSize, calibration)`.
  - `upsertLearnedPrior(agentId, model, learnedPrior)`.
  - `updateRosterFlag(agentId, model, streak, flagged)`.
  - `getResolvedForecasts(limit)` / `getAgentBoardRows(limit)` — SELECT `sv.model` (aliased `model`).

- [ ] **Step 1: Write the failing test**

Add to `test/db/repo.test.js` (matching the file's existing mock-`db` style — a fake `db.query` capturing SQL + params):

```javascript
it('addSignalVotes inserts the served model, defaulting null to the oracle model', async () => {
  const calls = [];
  const db = { query: async (sql, params) => (calls.push({ sql, params }), { rows: [] }) };
  const repo = createRepo(db);
  await repo.addSignalVotes(7, [
    { agentId: 'news', stance: 1, conviction: 0.7, weight: 1.2, model: 'gpt-oss:20b' },
    { agentId: 'social', stance: 0, conviction: 0, weight: 0.8, model: null },
  ]);
  expect(calls[0].sql).toContain('legion.signal_votes (signal_id, agent_id, stance, conviction, weight, model)');
  expect(calls[0].params).toEqual([
    7, 'news', 1, 0.7, 1.2, 'gpt-oss:20b',
    7, 'social', 0, 0, 0.8, 'qwen2.5:7b-instruct',
  ]);
});

it('getAllReliability returns a nested agent->model->rho map', async () => {
  const db = {
    query: async () => ({
      rows: [
        { agent_id: 'news', model: 'gpt-oss:20b', rho: 1.3 },
        { agent_id: 'news', model: 'qwen2.5:7b-instruct', rho: 0.9 },
      ],
    }),
  };
  const repo = createRepo(db);
  expect(await repo.getAllReliability()).toEqual({
    news: { 'gpt-oss:20b': 1.3, 'qwen2.5:7b-instruct': 0.9 },
  });
});
```

(Use the test file's actual repo constructor name/import — shown here as `createRepo`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo.test.js`
Expected: FAIL — `model` not inserted; `getAllReliability` returns a flat map.

- [ ] **Step 3: Implement the repo changes**

`addSignalVotes` — 6 columns, default model:

```javascript
    async addSignalVotes(signalId, votes) {
      if (!votes.length) return;
      const tuples = [];
      const params = [];
      votes.forEach((v, i) => {
        const b = i * 6;
        tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
        params.push(
          signalId, v.agentId, v.stance, v.conviction, v.weight,
          v.model ?? 'qwen2.5:7b-instruct',
        );
      });
      await db.query(
        `INSERT INTO legion.signal_votes (signal_id, agent_id, stance, conviction, weight, model)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    },
```

Nested-map getter helper (add near the reliability getters) and rewrite the getters:

```javascript
    // Folds flat (agent_id, model, value) rows into { [agentId]: { [model]: value } }.
    // The emitter composes the (agent, model) lookup; the repo stays SQL-shaped.
    async getAllReliability() {
      const rows = await db.query(`SELECT agent_id, model, rho FROM legion.agent_reliability`);
      return nestByAgentModel(rows, 'rho');
    },

    async getAgentCalibration() {
      const rows = await db.query(`SELECT agent_id, model, calibration FROM legion.agent_reliability`);
      return nestByAgentModel(rows, 'calibration');
    },

    async getAgentInfoFactors() {
      const rows = await db.query(`SELECT agent_id, model, info_factor FROM legion.agent_reliability`);
      return nestByAgentModel(rows, 'info_factor');
    },
```

Add the module-level helper (top of `repo.js`, outside the factory):

```javascript
function nestByAgentModel(rows, valueKey) {
  const out = {};
  for (const r of rows) {
    (out[r.agent_id] ??= {})[r.model] = r[valueKey];
  }
  return out;
}
```

`upsertReliability` gains `model` in the key and the conflict target:

```javascript
    async upsertReliability(agentId, model, rho, sampleSize, calibration = 1.0, infoFactor = 1.0) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, model, rho, sample_size, calibration, info_factor, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (agent_id, model) DO UPDATE
           SET rho = EXCLUDED.rho, sample_size = EXCLUDED.sample_size,
               calibration = EXCLUDED.calibration, info_factor = EXCLUDED.info_factor,
               updated_at = now()`,
        [agentId, model, rho, sampleSize, calibration, infoFactor],
      );
    },
```

`getFlooredStreaks`, `updateRosterFlag`, `upsertLearnedPrior`, `getRegimeReliability`, `getRegimeCalibration`, `upsertRegimeReliability` — apply the same pattern (add `model` to SELECT and nest; add `model` to the key, conflict target, and params). For example:

```javascript
    async getFlooredStreaks() {
      const rows = await db.query(`SELECT agent_id, model, floored_streak FROM legion.agent_reliability`);
      return nestByAgentModel(rows, 'floored_streak');
    },

    async updateRosterFlag(agentId, model, streak, flagged) {
      await db.query(
        `UPDATE legion.agent_reliability
            SET floored_streak = $3, review_flagged = $4
          WHERE agent_id = $1 AND model = $2`,
        [agentId, model, streak, flagged],
      );
    },

    async upsertLearnedPrior(agentId, model, learnedPrior) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, model, learned_prior, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (agent_id, model) DO UPDATE
           SET learned_prior = EXCLUDED.learned_prior, updated_at = now()`,
        [agentId, model, learnedPrior],
      );
    },

    async getRegimeReliability(regime) {
      const rows = await db.query(
        `SELECT agent_id, model, rho FROM legion.agent_regime_reliability WHERE regime = $1`,
        [regime],
      );
      return nestByAgentModel(rows, 'rho');
    },

    async upsertRegimeReliability(agentId, regime, model, rho, sampleSize, calibration = 1.0) {
      await db.query(
        `INSERT INTO legion.agent_regime_reliability (agent_id, regime, model, rho, calibration, sample_size, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (agent_id, regime, model) DO UPDATE
           SET rho = EXCLUDED.rho, calibration = EXCLUDED.calibration,
               sample_size = EXCLUDED.sample_size, updated_at = now()`,
        [agentId, regime, model, rho, calibration, sampleSize],
      );
    },
```

(Match the real column name used for the roster flag — `review_flagged` above is illustrative; check `schema.sql`/the current `updateRosterFlag` for the exact name.)

`getResolvedForecasts` and `getAgentBoardRows` — add `sv.model`:

```javascript
        `SELECT sv.agent_id, sv.model, sv.stance, sv.conviction, s.outcome,
                s.forward_return, s.spy_return, s.regime
           FROM legion.signal_votes sv
           JOIN legion.signals s ON s.id = sv.signal_id
          WHERE s.resolved = true AND s.outcome IS NOT NULL
          ORDER BY s.id DESC
          LIMIT $1`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db/repo.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js test/db/repo.test.js
git commit -m "feat: repo persists + reads per-(agent, model) votes and dials"
```

---

## Task 7: Reliability recompute — bucket by `(agent, model)`

**Files:**
- Modify: `src/reliability/update.js`
- Test: `test/reliability/update.test.js` (create or extend)

**Interfaces:**
- Consumes: `getResolvedForecasts` rows now include `model` (Task 6); `upsertReliability(agentId, model, ...)`, `upsertRegimeReliability(agentId, regime, model, ...)`, `upsertLearnedPrior(agentId, model, ...)`, `updateRosterFlag(agentId, model, ...)`, `getFlooredStreaks()` nested (Task 6).
- Produces: `recomputeReliability(repo, logger)` buckets rows by `(agent_id, model)` instead of `agent_id`, computes the same dials per bucket, and upserts keyed by model. Return map keyed by `modelKey(agentId, model)` so callers/tests can read per-bucket results.

- [ ] **Step 1: Write the failing test**

Add to `test/reliability/update.test.js`:

```javascript
import { recomputeReliability } from '../../src/reliability/update.js';
import { modelKey } from '../../src/llm/provider.js';

it('computes separate dials per (agent, model)', async () => {
  // 6 resolved forecasts for news on gpt-oss (all beat SPY) and 6 on qwen (all lagged)
  const mk = (model, outcome) => ({
    agent_id: 'news', model, stance: 1, conviction: 0.8, outcome,
    forward_return: outcome ? 0.05 : -0.05, spy_return: 0, regime: 'calm',
  });
  const rows = [
    ...Array(6).fill(0).map(() => mk('gpt-oss:20b', 1)),
    ...Array(6).fill(0).map(() => mk('qwen2.5:7b-instruct', 0)),
  ];
  const upserts = [];
  const repo = {
    getResolvedForecasts: async () => rows,
    getFlooredStreaks: async () => ({}),
    upsertReliability: async (...a) => upserts.push(a),
    upsertRegimeReliability: async () => {},
    upsertLearnedPrior: async () => {},
    updateRosterFlag: async () => {},
  };
  const map = await recomputeReliability(repo, { warn() {} });
  const good = map[modelKey('news', 'gpt-oss:20b')];
  const bad = map[modelKey('news', 'qwen2.5:7b-instruct')];
  expect(good.rho).toBeGreaterThan(1.0); // skilled model
  expect(bad.rho).toBeLessThan(1.0); // unskilled model
  // upserts carry the model as the 2nd arg
  expect(upserts.every((a) => typeof a[1] === 'string')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reliability/update.test.js`
Expected: FAIL — buckets are per-agent, `upsertReliability` called without a model arg.

- [ ] **Step 3: Implement `(agent, model)` bucketing**

In `src/reliability/update.js`:

Add the import:

```javascript
import { modelKey } from '../llm/provider.js';
```

Change `bucketByAgent` to key by `(agent, model)` (rename to `bucketByAgentModel`), preserving the `pick`/`cap` semantics. It must return a Map whose entries expose both ids:

```javascript
// Groups rows per (agent, model), newest-first, capped at `cap` each. `pick`
// filters which rows enter the bucket (e.g. a regime). The map key is the
// modelKey composite; each value is { agentId, model, rows }.
function bucketByAgentModel(rows, pick = () => true, cap = WINDOW) {
  const byBucket = new Map();
  for (const r of rows) {
    if (!pick(r)) continue;
    const key = modelKey(r.agent_id, r.model);
    if (!byBucket.has(key)) byBucket.set(key, { agentId: r.agent_id, model: r.model, rows: [] });
    const bucket = byBucket.get(key);
    if (bucket.rows.length < cap) bucket.rows.push(r);
  }
  return byBucket;
}
```

Rewrite the three loops in `recomputeReliability` to iterate the new buckets and pass `model` to the upserts. The unconditional loop:

```javascript
  const map = {};
  for (const [key, { agentId, model, rows: agentRows }] of bucketByAgentModel(rows)) {
    const { rho, calibration, weights } = computeDials(agentRows);
    const info = informationFactor(
      stanceVariance(agentRows.map((r) => r.stance), weights),
      agentRows.length,
    );
    map[key] = { agentId, model, rho, calibration, info };
    await repo.upsertReliability(agentId, model, rho, agentRows.length, calibration, info);

    const prev = streaks[agentId]?.[model] ?? 0;
    const streak = rho <= ROSTER_FLOOR_EPS ? prev + 1 : 0;
    const flagged = streak >= ROSTER_FLAG_AFTER;
    map[key].flooredStreak = streak;
    map[key].flagged = flagged;
    if (flagged) {
      logger.warn?.(
        `[reliability] ${agentId} (${model}) has been at the rho floor for ${streak} recomputes — review it on the Agents tab`,
      );
    }
    await repo.updateRosterFlag?.(agentId, model, streak, flagged);
  }
```

Learned-prior loop:

```javascript
  for (const [key, { agentId, model, rows: longRows }] of bucketByAgentModel(rows, () => true, LONG_WINDOW)) {
    const uniform = longRows.map(() => 1);
    const { rho: learnedPrior } = computeDials(longRows, uniform);
    if (map[key]) map[key].learnedPrior = learnedPrior;
    await repo.upsertLearnedPrior?.(agentId, model, learnedPrior);
  }
```

Regime loop:

```javascript
  for (const regime of REGIMES) {
    for (const [, { agentId, model, rows: agentRows }] of bucketByAgentModel(rows, (r) => r.regime === regime)) {
      if (agentRows.length < MIN_RESOLVED) continue;
      const { rho, calibration } = computeDials(agentRows);
      await repo.upsertRegimeReliability?.(agentId, regime, model, rho, agentRows.length, calibration);
    }
  }
  return map;
```

Note `getFlooredStreaks()` now returns a nested map (Task 6), hence `streaks[agentId]?.[model]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/reliability/update.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reliability/update.js test/reliability/update.test.js
git commit -m "feat: recompute reliability dials per (agent, model)"
```

---

## Task 8: Apply dials per `(agent, model)` in scaling helpers

**Files:**
- Modify: `src/consensus/reliability.js`
- Test: `test/consensus/reliability.test.js`

**Interfaces:**
- Consumes: votes now carry `model` (Task 4); `modelKey` (Task 3).
- Produces:
  - `scaleWeights(votes, rhoLookup)` and `scaleConviction(votes, calibLookup)` accept a **lookup function** `(agentId, model) => number` (default `() => 1.0`). The emitter (Task 9) builds these from the nested maps. Backward note: callers that passed a flat `{agentId: value}` map must migrate to a lookup — the only callers are the emitter (Task 9) and these tests.

- [ ] **Step 1: Write the failing test**

Replace/extend the `scaleWeights`/`scaleConviction` tests in `test/consensus/reliability.test.js`:

```javascript
it('scaleWeights multiplies by rho for the vote\'s own (agent, model)', () => {
  const votes = [
    { agentId: 'news', model: 'gpt-oss:20b', weight: 1.2 },
    { agentId: 'news', model: 'qwen2.5:7b-instruct', weight: 1.2 },
  ];
  const rho = { news: { 'gpt-oss:20b': 1.5, 'qwen2.5:7b-instruct': 0.5 } };
  const lookup = (agentId, model) => rho[agentId]?.[model] ?? 1.0;
  const out = scaleWeights(votes, lookup);
  expect(out[0].weight).toBeCloseTo(1.8);
  expect(out[1].weight).toBeCloseTo(0.6);
});

it('scaleConviction clamps to [0,1] using the (agent, model) calibration', () => {
  const votes = [{ agentId: 'news', model: 'gpt-oss:20b', conviction: 0.8 }];
  const lookup = () => 1.5;
  expect(scaleConviction(votes, lookup)[0].conviction).toBe(1); // 0.8*1.5 clamped
});

it('defaults missing dials to 1.0', () => {
  const votes = [{ agentId: 'x', model: 'm', weight: 1, conviction: 0.5 }];
  expect(scaleWeights(votes)[0].weight).toBe(1);
  expect(scaleConviction(votes)[0].conviction).toBe(0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consensus/reliability.test.js`
Expected: FAIL — helpers still index a flat map by `agentId`.

- [ ] **Step 3: Implement lookup-based scaling**

In `src/consensus/reliability.js`:

```javascript
export function scaleWeights(votes, rhoLookup = () => 1.0) {
  return votes.map((v) => ({
    ...v,
    weight: v.weight * (rhoLookup(v.agentId, v.model) ?? 1.0),
  }));
}

export function scaleConviction(votes, calibLookup = () => 1.0) {
  return votes.map((v) => ({
    ...v,
    conviction: clamp(v.conviction * (calibLookup(v.agentId, v.model) ?? 1.0), 0, 1),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consensus/reliability.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consensus/reliability.js test/consensus/reliability.test.js
git commit -m "feat: scale weight/conviction by each vote's (agent, model) dial"
```

---

## Task 9: Emitter — build per-`(agent, model)` lookups, persist model

**Files:**
- Modify: `src/emit/emitter.js`
- Test: `test/emit/emitter.test.js`

**Interfaces:**
- Consumes: nested dial maps from repo (Task 6); lookup-based `scaleWeights`/`scaleConviction` (Task 8); votes carry `model` (Task 4).
- Produces: `learnedForCycle` returns `{ rhoLookup, calibLookup, corr, regime }` where the lookups are `(agentId, model) => number`. The regime overlay merges per `(agent, model)` (nested-map spread at the model level). `finalize` persists `model` in the snapshot votes.

- [ ] **Step 1: Write the failing test**

Add to `test/emit/emitter.test.js` an assertion that a finalized signal's snapshot votes carry the served model, and that an agent's vote is weighted by its model's ρ. Use the file's existing emitter harness (fake `repo`, `bus`). Minimal addition:

```javascript
it('persists the served model on snapshot votes', async () => {
  // ... arrange the existing emitter harness so a cycle finalizes with one vote
  // carrying model 'gpt-oss:20b' ...
  // assert the repo.addSignalVotes spy received a vote with model 'gpt-oss:20b'
  const persisted = addSignalVotesSpy.mock.calls.at(-1)[1];
  expect(persisted[0].model).toBe('gpt-oss:20b');
});
```

(Follow the existing test's arrange/act scaffolding; the new assertion is the deliverable.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/emitter.test.js`
Expected: FAIL — snapshot votes have no `model`.

- [ ] **Step 3: Build lookups in `learnedForCycle`**

Replace the dial assembly in `learnedForCycle` (lines ~292–315). The repo getters now return nested `{[agentId]:{[model]:value}}` maps:

```javascript
      const rhoEff = mergeNested(rho, regimeRho); // regime overlay at the (agent, model) level
      const calEff = mergeNested(calibration, regimeCal);
      // conviction term = calibration × information factor, per (agent, model)
      const calibLookup = (agentId, model) => {
        const cal = calEff[agentId]?.[model] ?? 1.0;
        const inf = info[agentId]?.[model] ?? 1.0;
        return cal * inf;
      };
      const rhoLookup = (agentId, model) => rhoEff[agentId]?.[model] ?? 1.0;
      const corr = (a, b) => corrMap[a]?.[b] ?? 0;
      learnedByCycle.set(cycleId, { rhoLookup, calibLookup, corr, regime });
```

Add the module-level helper (top of `emitter.js`):

```javascript
// Overlays regime-conditional nested dials onto the unconditional ones at the
// (agent, model) leaf: a deep-enough regime bucket overrides the base value,
// otherwise the base survives. Mirrors the old `{...rho, ...regimeRho}` spread
// but one level deeper now that dials are keyed by (agent, model).
function mergeNested(base, overlay) {
  const out = {};
  for (const agentId of new Set([...Object.keys(base), ...Object.keys(overlay)])) {
    out[agentId] = { ...(base[agentId] ?? {}), ...(overlay[agentId] ?? {}) };
  }
  return out;
}
```

Update the consumer in `process` (lines ~328–330):

```javascript
    const { rhoLookup, calibLookup, corr } = await learnedForCycle(cycleId);
    const scaled = scaleWeights(entry.votes, rhoLookup);
    const calibrated = scaleConviction(scaled, calibLookup);
```

`finalize` snapshot — add `model` (around line 432–438):

```javascript
    await repo.addSignalVotes?.(
      signalId,
      scaled.map((v) => ({
        agentId: v.agentId,
        stance: v.stance,
        conviction: v.conviction,
        weight: v.weight,
        model: v.model ?? null,
      })),
    );
```

(`scaleWeights` spreads `...v`, so `model` survives from the raw vote into `scaled`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/emit/emitter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/emit/emitter.js test/emit/emitter.test.js
git commit -m "feat: emitter applies + persists per-(agent, model) dials"
```

---

## Task 10: Global home-PC toggle — repo flag, settings route, per-cycle gate

**Files:**
- Modify: `src/db/repo.js`
- Create: `src/api/routes/settings.js`
- Modify: `src/api/app.js` (mount the route)
- Modify: `src/agents/get-provider.js` (overlay `home.enabled` per cycle)
- Test: `test/api/settings.test.js`, `test/agents/get-provider.test.js`

**Interfaces:**
- Consumes: `runtime_config` table (Task 5); `createProvider` reads `cfg.home.enabled` (Task 3).
- Produces:
  - `repo.getHomePcEnabled() -> Promise<boolean>` — reads `runtime_config` key `home_pc_enabled`; **defaults `true`** when the row is absent.
  - `repo.setHomePcEnabled(enabled: boolean) -> Promise<void>` — upserts the key as `'true'`/`'false'`.
  - `GET /api/settings -> { homePcEnabled: boolean }`; `PUT /api/settings { homePcEnabled }` -> the new state.
  - `buildGetProvider` reads `repo.getHomePcEnabled()` once per `getProvider({agentId})` call and overlays it into `cfg.home.enabled` before constructing the provider, so a toggle flip takes effect next cycle with no redeploy.

- [ ] **Step 1: Write the failing tests**

`test/api/settings.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { settingsRoutes } from '../../src/api/routes/settings.js';

function appWith(repo) {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(repo));
  return app;
}

describe('settings routes', () => {
  it('GET returns the home-PC flag', async () => {
    const repo = { getHomePcEnabled: async () => false };
    const res = await request(appWith(repo)).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ homePcEnabled: false });
  });

  it('PUT updates the flag', async () => {
    const set = vi.fn(async () => {});
    const repo = { setHomePcEnabled: set, getHomePcEnabled: async () => true };
    const res = await request(appWith(repo)).put('/api/settings').send({ homePcEnabled: true });
    expect(res.status).toBe(200);
    expect(set).toHaveBeenCalledWith(true);
    expect(res.body).toEqual({ homePcEnabled: true });
  });

  it('PUT rejects a non-boolean flag', async () => {
    const res = await request(appWith({})).put('/api/settings').send({ homePcEnabled: 'yes' });
    expect(res.status).toBe(400);
  });
});
```

Add to `test/agents/get-provider.test.js`:

```javascript
it('disables the home tier when the global toggle is off', async () => {
  const built = [];
  const factory = ({ type, model }) => {
    built.push({ type, model });
    return { name: type, model, generate: async () => 'x' };
  };
  const repo = {
    getAgentConfig: async () => ({ provider: 'local', model: null, enabled: true }),
    getHomePcEnabled: async () => false,
  };
  const cfg = { ollama: { url: 'o' }, home: { url: 'http://pc:11434', enabled: true, model: 'gpt-oss:20b' } };
  const getProvider = buildGetProvider({ repo, cfg });
  await getProvider({ agentId: 'news' });
  // the cfg passed into createProvider must have home.enabled === false
  // (assert via a factory that inspects cfg — see note below)
});
```

Note: `buildGetProvider`'s default factory calls `createProvider`. To assert the overlay without a live provider, the test injects a `factory` and the implementation must apply the `home.enabled` overlay to `cfg` *before* `createProvider`/the factory runs. Adjust the assertion to inspect the cfg the factory received (extend the injected factory signature in the implementation to receive cfg, or assert behavior via a probe-counting fetch). Keep the test aligned with the implementation in Step 3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/settings.test.js test/agents/get-provider.test.js`
Expected: FAIL — `settingsRoutes` missing; toggle not applied.

- [ ] **Step 3: Implement**

`src/db/repo.js` — add:

```javascript
    async getHomePcEnabled() {
      const row = await db.queryOne(
        `SELECT value FROM legion.runtime_config WHERE key = 'home_pc_enabled'`,
      );
      return row ? row.value === 'true' : true; // default ON when unset
    },

    async setHomePcEnabled(enabled) {
      await db.query(
        `INSERT INTO legion.runtime_config (key, value, updated_at)
         VALUES ('home_pc_enabled', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [enabled ? 'true' : 'false'],
      );
    },
```

`src/api/routes/settings.js`:

```javascript
import { Router } from 'express';

// Global runtime flags editable from the dashboard. Currently just the home-PC
// model kill switch (a manual override on top of the PC-side busy-check).
export function settingsRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ homePcEnabled: await repo.getHomePcEnabled() });
    } catch (err) {
      next(err);
    }
  });

  router.put('/', async (req, res, next) => {
    try {
      const { homePcEnabled } = req.body ?? {};
      if (typeof homePcEnabled !== 'boolean') {
        return res.status(400).json({ error: 'homePcEnabled must be a boolean' });
      }
      await repo.setHomePcEnabled(homePcEnabled);
      res.json({ homePcEnabled });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

`src/api/app.js` — mount it next to the other route registrations:

```javascript
import { settingsRoutes } from './routes/settings.js';
// ...
app.use('/api/settings', settingsRoutes(repo));
```

`src/agents/get-provider.js` — overlay the toggle. The default factory builds via `createProvider`; apply the flag to `cfg.home.enabled` before constructing:

```javascript
  return async ({ agentId }) => {
    const c = await repo.getAgentConfig(agentId);
    if (!c) return null;
    if (c.enabled === false) return { enabled: false };

    // Global kill switch: a per-cycle DB read so a dashboard flip takes effect
    // next cycle with no redeploy. Defaults ON when unset.
    const homeEnabled = (await repo.getHomePcEnabled?.()) ?? true;
    const cfgWithToggle = { ...cfg, home: { ...cfg.home, enabled: homeEnabled } };

    const build =
      factory ??
      (({ type, model }) =>
        createProvider(type, withModel(withAgentOptions(cfgWithToggle, options), type, model)));

    return {
      provider: resolveProvider({ provider: c.provider, model: c.model }, build),
      enabled: true,
    };
  };
```

Move the `build` definition inside the returned closure (it now depends on the per-cycle `cfgWithToggle`). Keep the injected-`factory` path taking precedence for tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/api/settings.test.js test/agents/get-provider.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js src/api/routes/settings.js src/api/app.js src/agents/get-provider.js test/
git commit -m "feat: global home-PC toggle (runtime_config + settings route + per-cycle gate)"
```

---

## Task 11: Dashboard toggle UI

**Files:**
- Modify: `web/src/api/client.js`
- Modify: `web/src/pages/AgentConfig.jsx`
- Test: `web/test/AgentConfig.test.jsx` (if the web suite exists; otherwise verify via `npm run -w web build` + manual check and note it).

**Interfaces:**
- Consumes: `GET/PUT /api/settings` (Task 10).
- Produces: `api.getSettings()`, `api.setSettings(body)`; a checkbox above the agent table bound to `homePcEnabled`, saved on change.

- [ ] **Step 1: Add the client methods**

In `web/src/api/client.js`, add to the `api` object:

```javascript
  getSettings: () => get('/api/settings'),
  setSettings: (body) => send('PUT', '/api/settings', body),
```

- [ ] **Step 2: Add the toggle to AgentConfig**

In `web/src/pages/AgentConfig.jsx`, add state + a control above the table:

```javascript
  const [homePcEnabled, setHomePcEnabled] = useState(true);

  useEffect(() => {
    api.getSettings().then((s) => setHomePcEnabled(s.homePcEnabled)).catch(() => {});
  }, []);

  async function toggleHomePc(next) {
    setHomePcEnabled(next);
    await api.setSettings({ homePcEnabled: next });
  }
```

Render before the `<table>`:

```jsx
  <label className="flex items-center gap-2 mb-3">
    <input
      aria-label="home-pc-enabled"
      type="checkbox"
      checked={homePcEnabled}
      onChange={(e) => toggleHomePc(e.target.checked)}
    />
    Use home PC model (falls back to Oracle when off, asleep, or busy)
  </label>
```

(Wrap the existing `<table>` and this label in a fragment/`<div>` since the component now returns more than one element.)

- [ ] **Step 3: Build the web bundle to verify**

Run: `npm run -w web build` (or the repo's web build script)
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/client.js web/src/pages/AgentConfig.jsx web/test/
git commit -m "feat: dashboard toggle for the home PC model"
```

---

## Task 12: Full suite + operator runbook (Phases 2–3)

**Files:**
- Create: `docs/RUNBOOK-pc-model-server.md`
- Verify: whole repo test suite.

- [ ] **Step 1: Run the whole backend suite**

Run: `npx vitest run`
Expected: PASS (no regressions). Fix any test that still passes a flat reliability map or asserts a string generate result from the tiered path.

- [ ] **Step 2: Run lint**

Run: `npx eslint .`
Expected: clean (the pre-commit hook runs this; resolve any unused-var/error-handling findings).

- [ ] **Step 3: Write the runbook**

Create `docs/RUNBOOK-pc-model-server.md` covering — with exact commands — the operator setup the code depends on:

- **Tailscale:** install on the Oracle VM host and the PC; `tailscale up`; record the PC's `100.x` (or MagicDNS) address; ACL stanza restricting the PC's `:11434` (and sidecar port) to the VM node only.
- **Docker → tailnet reach:** run `tailscaled` on the VM host; verify a legion container can curl `http://<pc-tailnet>:11434/api/tags` (e.g. `docker exec legion-agent-news wget -qO- http://<pc>:11434/api/tags`). If host routing fails, the sidecar-container fallback (a `tailscale` service in `docker-compose.prod.yml` with the agents joining its network namespace).
- **PC Ollama + model:** install Ollama; `ollama pull gpt-oss:20b`; set `OLLAMA_KEEP_ALIVE=90m`; confirm VRAM headroom on the 16GB card.
- **Readiness sidecar:** a small HTTP server on the PC that the legion probe (`GET /api/tags` against `HOME_OLLAMA_URL`) reaches; it returns ready only when **NOT busy** — BUSY if recent user input (`GetLastInputInfo`, threshold e.g. 10 min) OR a fullscreen/exclusive app is foreground OR non-Ollama VRAM (`nvidia-smi`, excluding `ollama`) exceeds a threshold. Document how the sidecar gates `/api/tags` (proxy that returns 503 when busy) so legion stays sidecar-agnostic. Response diag shape: `{ ready, reason, gpuFreeMiB, idleSec }`.
- **Wake (RTC):** Windows Task Scheduler tasks with "Wake the computer to run this task" ~10 min before each cron window; "Allow wake timers" = ON; document that S3/S4 (sleep/hibernate) wake works but **S5 (full shutdown) does not** — configure power to sleep→hibernate, never auto-shutdown.
- **Prime:** on-wake task that runs the busy-check, and if clear, sends a warmup `generate` to load the model and set `keep_alive`.
- **Sleep:** Windows idle sleep (e.g. 20 min); `keep_alive` expiry unloads the model.
- **legion env:** set `HOME_OLLAMA_URL=http://<pc-tailnet>:11434`, `HOME_MODEL=gpt-oss:20b`, `HOME_THINK=false`, optionally `HOME_PROBE_TIMEOUT_MS`. Leave unset to disable the whole feature.
- **Verification checklist:** (1) with PC asleep, a cycle completes on Oracle and probe fails fast; (2) with PC awake+idle, votes are tagged `gpt-oss:20b` (check `SELECT DISTINCT model FROM legion.signal_votes`); (3) gaming/active → busy → Oracle; (4) dashboard toggle OFF → Oracle even when PC ready; (5) after a model switch, the new `(agent, model)` ρ starts at 1.0 and moves after `MIN_RESOLVED` resolves.

- [ ] **Step 4: Commit**

```bash
git add docs/RUNBOOK-pc-model-server.md
git commit -m "docs: operator runbook for PC model server (Tailscale, sidecar, wake/prime/sleep)"
```

---

## Self-Review notes (for the executor)

- **Reflection path:** Task 4 normalizes `reflect.js`. Grep `provider.generate` after Task 4 — any remaining un-normalized caller of a `local` provider will receive `{text, model}` instead of a string. The only model-aware caller is the agent runner; all others must use `normalizeGenerate(...).text`.
- **Roster flag column name:** Task 6 uses `review_flagged` illustratively — confirm the real column from the current `updateRosterFlag`/`schema.sql` before writing the UPDATE.
- **Regime PK arity:** Task 5's `DO $$` guard assumes `agent_regime_reliability` currently has a 2-column PK `(agent_id, regime)`. Confirm with `\d` and adjust the guard's `array_length = N` if different.
- **Web test harness:** if `web/test` has no React test runner, Task 11 verification is the build + manual check; do not invent a test framework.
