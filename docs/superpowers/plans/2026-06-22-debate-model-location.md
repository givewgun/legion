# Debate Model + Run Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag every agent vote with the served model name and a named source (`pc`/`oracle`/`openai`/`gemini`), derive an onprem/cloud class, and surface both on the debate thread and the Telegram signal.

**Architecture:** Providers report which backend served each call (`source`). That rides the existing vote object through NATS to the emitter, gets persisted on the per-round `legion.votes` table (new `model`/`source` columns), and is rendered by `DebateThread` and `formatSignal`. The display class `location` (`onprem`/`cloud`) is derived from `source` at each edge, never stored.

**Tech Stack:** Node ES modules, Vitest, Postgres (idempotent `schema.sql`), React + Tailwind (web), MarkdownV2 (Telegram).

## Global Constraints

- ES modules, `const`/`let`, arrow callbacks, template literals — match existing style.
- TDD: failing test first, minimal impl, green, commit. Use idiomatic vitest (`expect`/`toBe`/`toEqual`), not node `assert`.
- `source` values are exactly: `pc`, `oracle`, `openai`, `gemini`. `location` values: `onprem` (only `pc`), else `cloud`; `null` source → `null` location.
- Legacy/null-safe: a null `model` means no badge / no Telegram tag — never crash.
- Do NOT commit with `--no-verify`; lint-staged + ESLint must pass.
- Schema changes go in `src/db/schema.sql` in the existing `ALTER … ADD COLUMN IF NOT EXISTS` style — no new migration file.

---

### Task 1: `locationForSource` helper (backend + web)

**Files:**
- Create: `src/llm/source.js`
- Test: `test/llm/source.test.js`
- Create: `web/src/lib/source.js` (sibling copy — web is a separate bundle)
- Test: `web/test/lib/source.test.js`

**Interfaces:**
- Produces: `locationForSource(source: string|null): 'onprem'|'cloud'|null` in both `src/llm/source.js` and `web/src/lib/source.js` (identical).

- [ ] **Step 1: Write the failing test** — `test/llm/source.test.js`

```js
import { describe, it, expect } from 'vitest';
import { locationForSource } from '../../src/llm/source.js';

describe('locationForSource', () => {
  it('maps pc to onprem', () => {
    expect(locationForSource('pc')).toBe('onprem');
  });
  it('maps every other backend to cloud', () => {
    for (const s of ['oracle', 'openai', 'gemini']) expect(locationForSource(s)).toBe('cloud');
  });
  it('returns null for a null/absent source', () => {
    expect(locationForSource(null)).toBeNull();
    expect(locationForSource(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run test/llm/source.test.js`
Expected: FAIL — cannot resolve `../../src/llm/source.js`.

- [ ] **Step 3: Implement** — `src/llm/source.js`

```js
// Display class for a served-backend source id. The home PC is the only on-prem
// box; every other backend (Oracle VM, OpenAI, Gemini) is cloud. A null/absent
// source (e.g. a fetch-failed abstain that never reached a provider) → null.
export function locationForSource(source) {
  if (source == null) return null;
  return source === 'pc' ? 'onprem' : 'cloud';
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run test/llm/source.test.js`
Expected: PASS.

- [ ] **Step 5: Mirror for web** — `web/src/lib/source.js`

```js
// Mirror of src/llm/source.js (web is a separate bundle, no shared import).
// pc → onprem; every other backend → cloud; null/absent → null.
export function locationForSource(source) {
  if (source == null) return null;
  return source === 'pc' ? 'onprem' : 'cloud';
}
```

And `web/test/lib/source.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { locationForSource } from '../../src/lib/source.js';

describe('locationForSource (web)', () => {
  it('maps pc to onprem, others to cloud, null to null', () => {
    expect(locationForSource('pc')).toBe('onprem');
    expect(locationForSource('oracle')).toBe('cloud');
    expect(locationForSource(null)).toBeNull();
  });
});
```

- [ ] **Step 6: Run both, verify pass**

Run: `npx vitest run test/llm/source.test.js` and (from `web/`) `npx vitest run test/lib/source.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/llm/source.js test/llm/source.test.js web/src/lib/source.js web/test/lib/source.test.js
git commit -m "feat: add locationForSource source→onprem/cloud helper"
```

---

### Task 2: Providers report `source`

**Files:**
- Modify: `src/llm/ollama.js` (constructor params + returned object)
- Modify: `src/llm/openai.js` (returned object)
- Modify: `src/llm/provider.js` (`buildLocalProvider`, `createProvider`, `normalizeGenerate`)
- Modify: `src/llm/tiered.js` (`generate` return)
- Test: `test/llm/tiered.test.js` (update existing assertions), `test/llm/openai.test.js`, `test/llm/resolve-provider.test.js`

**Interfaces:**
- Consumes: `locationForSource` (not directly — source strings only).
- Produces:
  - `createOllamaProvider({ …, source = 'oracle' })` → provider with `.source`.
  - `createOpenAICompatProvider({ name, … })` → provider with `.source === name`.
  - `createTieredProvider(...).generate()` → `{ text, model, source }` (source = serving tier).
  - `normalizeGenerate(provider, args)` → `{ text, model, source }`.

- [ ] **Step 1: Update tiered test (failing)** — `test/llm/tiered.test.js`

Change the `stub` factory to carry a source, and update the two `toEqual` assertions:

```js
const stub = (model, source, impl) => ({
  name: 'local',
  model,
  source,
  generate: vi.fn(impl ?? (async () => `from-${model}`)),
});
```

Update every `stub('gpt-oss:20b')` → `stub('gpt-oss:20b', 'pc')` and `stub('qwen2.5:7b-instruct')` → `stub('qwen2.5:7b-instruct', 'oracle')` (and the `stub('x')` → `stub('x', 'oracle')`). Update the two equality assertions:

```js
// primary-served case:
expect(out).toEqual({ text: 'from-gpt-oss:20b', model: 'gpt-oss:20b', source: 'pc' });
// fallback / failover cases:
expect(out).toEqual({ text: 'from-qwen2.5:7b-instruct', model: 'qwen2.5:7b-instruct', source: 'oracle' });
```

Add one explicit failover-source case:

```js
it('reports the fallback source on mid-call primary failover', async () => {
  const primary = stub('gpt-oss:20b', 'pc', async () => {
    throw new Error('timed out');
  });
  const fallback = stub('qwen2.5:7b-instruct', 'oracle');
  const t = createTieredProvider({ primary, fallback, probe: async () => true });
  const out = await t.generate({ system: 's', prompt: 'p' });
  expect(out.source).toBe('oracle');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run test/llm/tiered.test.js`
Expected: FAIL — `source` missing from `generate` output.

- [ ] **Step 3: Implement tiered** — `src/llm/tiered.js`, replace the `generate` body:

```js
async generate({ system, prompt }) {
  if (await usePrimary()) {
    try {
      const text = await primary.generate({ system, prompt });
      return { text, model: primary.model, source: primary.source };
    } catch {
      // primary errored (timeout / transport / 5xx after its own retries) —
      // fail this call over to the always-available fallback.
    }
  }
  const text = await fallback.generate({ system, prompt });
  return { text, model: fallback.model, source: fallback.source };
}
```

- [ ] **Step 4: Run tiered test, verify pass**

Run: `npx vitest run test/llm/tiered.test.js`
Expected: PASS.

- [ ] **Step 5: Implement ollama source** — `src/llm/ollama.js`

In the destructured params of `createOllamaProvider`, add `source = 'oracle'`:

```js
export function createOllamaProvider(
  { url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1, options = null, think = null, source = 'oracle' },
  clientFactory = (opts) => new Ollama(opts),
) {
```

In the returned object, add `source` after `model`:

```js
  return {
    name: 'local',
    model,
    source,
    async generate({ system, prompt }) {
```

- [ ] **Step 6: Implement openai source** — `src/llm/openai.js`, returned object:

```js
  return {
    name,
    model,
    source: name,
    async generate({ system, prompt }) {
```

- [ ] **Step 7: Tag tiers + passthrough** — `src/llm/provider.js`

In `buildLocalProvider`, tag both tiers:

```js
function buildLocalProvider(cfg, fetchImpl, clientFactory) {
  const oracle = createOllamaProvider({ ...cfg.ollama, source: 'oracle' }, clientFactory);
  const home = cfg.home;
  if (!home?.url || home.enabled === false) return oracle;

  const pc = createOllamaProvider(
    { ...cfg.ollama, url: home.url, model: home.model, think: home.think, source: 'pc' },
    clientFactory,
  );
```

Replace `normalizeGenerate`:

```js
export async function normalizeGenerate(provider, args) {
  const out = await provider.generate(args);
  if (typeof out === 'string') {
    return { text: out, model: provider.model ?? null, source: provider.source ?? null };
  }
  return out;
}
```

- [ ] **Step 8: Add source assertions to openai + resolve-provider tests**

In `test/llm/openai.test.js`, add:

```js
it('exposes source equal to its name', () => {
  const p = createOpenAICompatProvider({ name: 'gemini', url: 'http://x', apiKey: 'k', model: 'm' });
  expect(p.source).toBe('gemini');
});
```

In `test/llm/resolve-provider.test.js`, add a case asserting `normalizeGenerate` passes the tiered object's `source` through and reads `provider.source` for a string-returning provider:

```js
import { normalizeGenerate } from '../../src/llm/provider.js';

describe('normalizeGenerate source', () => {
  it('passes a tiered object source through unchanged', async () => {
    const provider = { generate: async () => ({ text: 't', model: 'm', source: 'pc' }) };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 't', model: 'm', source: 'pc' });
  });
  it('reads source off a string-returning provider', async () => {
    const provider = { model: 'm', source: 'oracle', generate: async () => 'hi' };
    expect(await normalizeGenerate(provider, {})).toEqual({ text: 'hi', model: 'm', source: 'oracle' });
  });
});
```

- [ ] **Step 9: Run the llm suite, verify pass**

Run: `npx vitest run test/llm`
Expected: PASS (all files).

- [ ] **Step 10: Commit**

```bash
git add src/llm/ollama.js src/llm/openai.js src/llm/provider.js src/llm/tiered.js test/llm
git commit -m "feat: providers report served source (pc/oracle/openai/gemini)"
```

---

### Task 3: Plumb `source` through the vote

**Files:**
- Modify: `src/consensus/vote.js` (`createVote`)
- Modify: `src/agents/parse.js` (`parseVote`)
- Modify: `src/agents/factory.js` (`handleCycle`, `abstain`)
- Test: `test/consensus/vote.test.js`, `test/agents/parse.test.js`, `test/agents/factory-provider.test.js`

**Interfaces:**
- Consumes: `normalizeGenerate` → `{ text, model, source }` (Task 2).
- Produces: vote object `{ agentId, stance, conviction, weight, rationale, model, source }`.

- [ ] **Step 1: Failing vote test** — `test/consensus/vote.test.js`, add:

```js
it('carries source, defaulting to null', () => {
  expect(createVote({ agentId: 'a', stance: 1, conviction: 0.5, weight: 1 }).source).toBeNull();
  expect(
    createVote({ agentId: 'a', stance: 1, conviction: 0.5, weight: 1, source: 'pc' }).source,
  ).toBe('pc');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run test/consensus/vote.test.js`
Expected: FAIL — `source` is `undefined`.

- [ ] **Step 3: Implement** — `src/consensus/vote.js`

```js
export function createVote({ agentId, stance, conviction, weight, rationale, model = null, source = null }) {
  return { agentId, stance, conviction, weight, rationale, model, source };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run test/consensus/vote.test.js`
Expected: PASS.

- [ ] **Step 5: Failing parse test** — `test/agents/parse.test.js`, add:

```js
it('threads source onto the parsed vote', () => {
  const text = '{"stance":1,"conviction":0.6,"rationale":"ok"}';
  const { vote } = parseVote(text, { agentId: 'news', weight: 1, model: 'm', source: 'pc' });
  expect(vote.source).toBe('pc');
  expect(vote.model).toBe('m');
});
```

- [ ] **Step 6: Run, verify fail**

Run: `npx vitest run test/agents/parse.test.js`
Expected: FAIL — `vote.source` is `null`.

- [ ] **Step 7: Implement** — `src/agents/parse.js`

```js
export function parseVote(text, { agentId, weight, model = null, source = null }) {
```

and add `source,` to the `createVote({ … })` call (after `model,`).

- [ ] **Step 8: Run, verify pass**

Run: `npx vitest run test/agents/parse.test.js`
Expected: PASS.

- [ ] **Step 9: Wire factory** — `src/agents/factory.js`, in `handleCycle` replace the generate block:

```js
      const { system, prompt } = buildPrompt(symbol, data, peers);
      const stopInference = agentInference.startTimer({ agent: id });
      let text;
      let servedModel = null;
      let servedSource = null;
      try {
        const out = await normalizeGenerate(activeProvider, {
          system,
          prompt: memory ? `${memory}\n\n${prompt}` : prompt,
        });
        text = out.text;
        servedModel = out.model;
        servedSource = out.source;
      } finally {
        stopInference();
      }
      const parsed = parseVote(text, { agentId: id, weight, model: servedModel, source: servedSource });
      if (parsed.ok) {
        vote = parsed.vote;
      } else {
        logger.warn(`[${id}] parse failed: ${parsed.errors.join('; ')}`);
        vote = abstain(id, weight, 'unparseable vote', servedModel, servedSource);
      }
```

And update `abstain`:

```js
function abstain(id, weight, reason, model = null, source = null) {
  return createVote({
    agentId: id,
    stance: 0,
    conviction: 0,
    weight,
    rationale: `abstain (${reason})`,
    model,
    source,
  });
}
```

- [ ] **Step 10: Failing factory test** — `test/agents/factory-provider.test.js`, add a case that a tiered-style provider's `source` lands on the published vote. Match the file's existing harness (fake `bus` capturing `publishJSON`, a `getProvider` returning a provider whose `generate` returns `{ text, model, source }`). Assert:

```js
it('tags the published vote with the served model and source', async () => {
  // …build agent with a provider.generate → { text: '{"stance":1,"conviction":0.5,"rationale":"x"}', model: 'gpt-oss:20b', source: 'pc' }…
  // …invoke the cycle handler…
  const published = bus.publishJSON.mock.calls.at(-1)[1].vote;
  expect(published.model).toBe('gpt-oss:20b');
  expect(published.source).toBe('pc');
});
```

(Use the existing test's construction pattern verbatim; only the provider stub return and the two assertions are new.)

- [ ] **Step 11: Run agent + consensus suites, verify pass**

Run: `npx vitest run test/agents test/consensus`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/consensus/vote.js src/agents/parse.js src/agents/factory.js test/consensus/vote.test.js test/agents/parse.test.js test/agents/factory-provider.test.js
git commit -m "feat: carry served source through vote → parse → factory"
```

---

### Task 4: Persist model + source on `legion.votes`

**Files:**
- Modify: `src/db/schema.sql` (ALTER votes)
- Modify: `src/db/repo.js` (`addVote`, `getVotes`)
- Test: `test/db/repo.test.js` (or `repo.read.test.js` — match where `addVote`/`getVotes` are already tested)

**Interfaces:**
- Consumes: vote `{ …, model, source }` (Task 3).
- Produces: `getVotes(roundId)` rows include `model`, `source`.

- [ ] **Step 1: Schema ALTER** — `src/db/schema.sql`, append near the other `ALTER … ADD COLUMN IF NOT EXISTS` block (after the `legion.votes` CREATE):

```sql
-- Served model + run source on the per-round audit table (debate display).
ALTER TABLE legion.votes ADD COLUMN IF NOT EXISTS model  TEXT;
ALTER TABLE legion.votes ADD COLUMN IF NOT EXISTS source TEXT;
```

- [ ] **Step 2: Failing repo test** — find the existing `addVote`/`getVotes` round-trip test (grep `getVotes` in `test/db`). Add a case (mirroring its setup of a cycle → round → vote):

```js
it('round-trips model and source on a vote', async () => {
  // …create cycle + round (reuse the file's helpers)…
  await repo.addVote(roundId, {
    agentId: 'news', stance: 1, conviction: 0.5, weight: 1, rationale: 'r', model: 'gpt-oss:20b', source: 'pc',
  });
  const [row] = await repo.getVotes(roundId);
  expect(row.model).toBe('gpt-oss:20b');
  expect(row.source).toBe('pc');
});
```

- [ ] **Step 3: Run, verify fail**

Run: `npx vitest run test/db/repo.test.js`
Expected: FAIL — `row.model`/`row.source` undefined (and INSERT lacks columns).

- [ ] **Step 4: Implement** — `src/db/repo.js`

`addVote`:

```js
    async addVote(roundId, vote) {
      const row = await db.queryOne(
        `INSERT INTO legion.votes (round_id, agent_id, stance, conviction, weight, rationale, model, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [roundId, vote.agentId, vote.stance, vote.conviction, vote.weight, vote.rationale, vote.model ?? null, vote.source ?? null],
      );
      return row.id;
    },
```

`getVotes`:

```js
    async getVotes(roundId) {
      const rows = await db.query(
        `SELECT agent_id, stance, conviction, weight, rationale, model, source
         FROM legion.votes WHERE round_id = $1 ORDER BY agent_id`,
        [roundId],
      );
      return rows;
    },
```

- [ ] **Step 5: Run, verify pass**

Run: `npx vitest run test/db/repo.test.js`
Expected: PASS. (If the DB suite needs a live Postgres and is skipped locally, note it and rely on CI.)

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/repo.js test/db/repo.test.js
git commit -m "feat: persist served model + source on legion.votes"
```

---

### Task 5: Telegram signal shows model + location

**Files:**
- Modify: `src/emit/plan.js` (`buildSignal` rationales)
- Modify: `src/emit/telegram.js` (`formatSignal`)
- Test: `test/emit/plan.test.js`, `test/emit/telegram.test.js`

**Interfaces:**
- Consumes: vote `{ …, model, source }`; `locationForSource` (Task 1).
- Produces: `signal.plan.rationales[i]` carries `model`, `source`; `formatSignal` appends `(model, location)`.

- [ ] **Step 1: Failing plan test** — `test/emit/plan.test.js`, add:

```js
it('carries served model and source onto each rationale', () => {
  const votes = [{ agentId: 'news', rationale: 'r', model: 'gpt-oss:20b', source: 'pc' }];
  const sig = buildSignal({ converged: true, band: 'BUY', S: 2, kappa: 1 }, { symbol: 'AAA', votes });
  expect(sig.plan.rationales[0]).toMatchObject({ agentId: 'news', model: 'gpt-oss:20b', source: 'pc' });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run test/emit/plan.test.js`
Expected: FAIL — rationale lacks `model`/`source`.

- [ ] **Step 3: Implement** — `src/emit/plan.js`, replace the `rationales` line:

```js
  const rationales = votes.map((v) => ({
    agentId: v.agentId,
    rationale: v.rationale,
    model: v.model ?? null,
    source: v.source ?? null,
  }));
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run test/emit/plan.test.js`
Expected: PASS.

- [ ] **Step 5: Failing telegram test** — `test/emit/telegram.test.js`, add:

```js
it('appends served model and location to each agent line', () => {
  const signal = {
    symbol: 'AAA', band: 'BUY', conviction: 1,
    plan: { rationales: [{ agentId: 'news', rationale: 'up', model: 'gpt-oss:20b', source: 'pc' }] },
  };
  const out = formatSignal(signal);
  expect(out).toContain('gpt-oss:20b');
  expect(out).toContain('onprem');
});

it('omits the tag when model is null', () => {
  const signal = {
    symbol: 'AAA', band: 'BUY', conviction: 1,
    plan: { rationales: [{ agentId: 'news', rationale: 'up', model: null, source: null }] },
  };
  expect(formatSignal(signal)).not.toContain('(');
});
```

- [ ] **Step 6: Run, verify fail**

Run: `npx vitest run test/emit/telegram.test.js`
Expected: FAIL — no model/location in output.

- [ ] **Step 7: Implement** — `src/emit/telegram.js`

Add the import at top:

```js
import { locationForSource } from '../llm/source.js';
```

Replace the rationales `.map(...)` inside `formatSignal`:

```js
    ...signal.plan.rationales.map((r) => {
      const loc = locationForSource(r.source);
      const tag = r.model ? ` (${r.model}${loc ? `, ${loc}` : ''})` : '';
      return `• _${escapeMarkdown(r.agentId)}_: ${escapeMarkdown(r.rationale)}${escapeMarkdown(tag)}`;
    }),
```

- [ ] **Step 8: Run, verify pass**

Run: `npx vitest run test/emit/plan.test.js test/emit/telegram.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/emit/plan.js src/emit/telegram.js test/emit/plan.test.js test/emit/telegram.test.js
git commit -m "feat: show served model + location in Telegram signal"
```

---

### Task 6: DebateThread badge

**Files:**
- Modify: `web/src/lib/debate.js` (`threadModel`)
- Modify: `web/src/components/DebateThread.jsx` (`Message`)
- Test: `web/test/lib/debate.test.js`, `web/test/components/DebateThread.test.jsx`

**Interfaces:**
- Consumes: round votes `{ …, model, source }` (Task 4); `locationForSource` from `web/src/lib/source.js` (Task 1).
- Produces: `threadModel` messages carry `model`, `source`, `location`.

- [ ] **Step 1: Failing debate.js test** — `web/test/lib/debate.test.js`, add:

```js
it('surfaces model, source, and derived location per message', () => {
  const rounds = [
    { round_no: 1, votes: [{ agent_id: 'news', stance: 1, conviction: 0.5, rationale: 'r', model: 'gpt-oss:20b', source: 'pc' }] },
  ];
  const [round] = threadModel(rounds);
  expect(round.messages[0]).toMatchObject({ model: 'gpt-oss:20b', source: 'pc', location: 'onprem' });
});
```

- [ ] **Step 2: Run, verify fail** (from `web/`)

Run: `npx vitest run test/lib/debate.test.js`
Expected: FAIL — message lacks model/source/location.

- [ ] **Step 3: Implement** — `web/src/lib/debate.js`

Add import at top:

```js
import { locationForSource } from './source.js';
```

In `threadModel`, extend the returned message object:

```js
      return {
        agentId: v.agent_id,
        stance: v.stance,
        conviction: v.conviction,
        rationale: v.rationale,
        model: v.model ?? null,
        source: v.source ?? null,
        location: locationForSource(v.source ?? null),
        delta,
        peers,
      };
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run test/lib/debate.test.js`
Expected: PASS.

- [ ] **Step 5: Failing component test** — `web/test/components/DebateThread.test.jsx`, add (match the file's existing render harness):

```js
it('renders a model · location badge', () => {
  const rounds = [
    { round_no: 1, converged: true, s_score: 2, dispersion: 0, quorum: 1,
      votes: [{ agent_id: 'news', stance: 1, conviction: 0.5, rationale: 'r', model: 'gpt-oss:20b', source: 'pc' }] },
  ];
  render(<DebateThread rounds={rounds} />);
  expect(screen.getByText(/gpt-oss:20b · onprem/)).toBeInTheDocument();
});
```

- [ ] **Step 6: Run, verify fail**

Run: `npx vitest run test/components/DebateThread.test.jsx`
Expected: FAIL — badge text absent.

- [ ] **Step 7: Implement** — `web/src/components/DebateThread.jsx`

In `Message`, inside the `flex flex-wrap items-center gap-2` header `<div>`, after the `<DeltaPill … />`, add:

```jsx
          {msg.model && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                msg.location === 'onprem'
                  ? 'bg-violet-100 text-violet-700'
                  : 'bg-sky-100 text-sky-700'
              }`}
            >
              {msg.model}
              {msg.location ? ` · ${msg.location}` : ''}
            </span>
          )}
```

- [ ] **Step 8: Run, verify pass**

Run: `npx vitest run test/components/DebateThread.test.jsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/debate.js web/src/components/DebateThread.jsx web/test/lib/debate.test.js web/test/components/DebateThread.test.jsx
git commit -m "feat: show served model + location badge in debate thread"
```

---

### Task 7: Full-suite verification

- [ ] **Step 1: Backend suite**

Run: `npx vitest run`
Expected: PASS (no regressions from the new vote/provider shapes).

- [ ] **Step 2: Web suite**

Run (from `web/`): `npx vitest run`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint` (or the project's lint script)
Expected: clean.

- [ ] **Step 4: Final review + push** — open PR per the session's branch `claude/debate-model-location`.
