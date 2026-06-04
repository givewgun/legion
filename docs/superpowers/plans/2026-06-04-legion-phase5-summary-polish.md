# Legion Phase 5 — Summary + Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the gestalt: a periodic Telegram digest of the window's signals, a UI to switch each agent's LLM provider at runtime, contributor docs for adding agents, and architecture decision records for the four core subsystems.

**Architecture:** Four loosely-coupled additions, each independently testable. (1) **Summary** — a pure formatter turns a window of persisted signals into a Telegram digest, driven by a cron runner. (2) **Provider switching** — per-agent LLM provider/model persisted in `legion.agent_config`, resolved at cycle time via a provider router, surfaced through an API + dashboard page. (3) **Docs** — a contributor guide for dropping in a new agent. (4) **ADRs** — consensus, message bus, inference abstraction, and deployment decisions captured under `docs/adr/`.

**Tech Stack:** Node.js ESM, Vitest, pg (fake-pool unit tests), node-cron, Express + supertest, Vite + React 18 + Tailwind + @testing-library/react + jsdom. Runtime local-first, ≈$0 (Gemini/OpenAI providers are opt-in per agent).

---

## Design constants

```
Default summary cadence:   LEGION_SUMMARY_CRON = '0 */6 * * *'   (every 6h)
Default summary window:    LEGION_SUMMARY_WINDOW_HOURS = 6
Provider names:            'local' (Ollama, default) | 'gemini' | 'openai'
Default model per provider: local→'qwen2.5:7b', gemini→'gemini-2.5-flash', openai→'gpt-4o-mini'
```

---

## File Structure

- `src/summary/build.js` — pure `buildSummary(signals, { since, until })` → Telegram markdown string.
- `src/db/repo.js` — MODIFY: `listSignalsSince(since)`; agent-config methods.
- `src/run/summary.js` — NEW: `runSummaryOnce(...)` + cron entrypoint.
- `migrations/phase5_agent_config.sql` — NEW: `legion.agent_config` table.
- `src/llm/provider.js` — MODIFY: `resolveProvider({ provider, model })` router + default-model map.
- `src/agents/factory.js` — MODIFY: optional per-cycle `getProvider({ agentId })`.
- `src/api/routes/agents.js` — NEW: GET/PATCH agent config; mounted in `src/api/app.js`.
- `web/src/api/client.js` — MODIFY: `listAgents`, `setAgent`.
- `web/src/pages/AgentConfig.jsx` — NEW; wired into `web/src/App.jsx`.
- `docs/adding-an-agent.md` — NEW contributor guide.
- `docs/adr/0001-consensus-protocol.md`, `0002-message-bus.md`, `0003-inference-abstraction.md`, `0004-deployment.md` — NEW ADRs.
- `config/index.js` — MODIFY: `summaryCron`, `summaryWindowHours`.
- `docker-compose.yml` — MODIFY: `summary` service.
- `README.md` — MODIFY: Phase 5 section.

---

### Task 1: Summary builder (pure)

**Files:**

- Create: `src/summary/build.js`
- Test: `test/summary/build.test.js`

`buildSummary(signals, { since, until })` returns a Telegram-markdown digest: a window header, counts of bullish / bearish / hold(=no-consensus) signals, and a "top calls" list (highest-conviction non-HOLD signals first). Empty window → a clear "no signals" line.

- [ ] **Step 1: Write the failing test**

```js
// test/summary/build.test.js
import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/summary/build.js';

const since = '2026-06-04T00:00:00Z';
const until = '2026-06-04T06:00:00Z';

describe('buildSummary', () => {
  it('reports a no-signals window plainly', () => {
    const text = buildSummary([], { since, until });
    expect(text).toMatch(/no signals/i);
    expect(text).toContain('06:00');
  });

  it('counts bullish, bearish, and hold signals', () => {
    const signals = [
      { symbol: 'NVDA', stance: 2, conviction: 0.9 },
      { symbol: 'MU', stance: 1, conviction: 0.6 },
      { symbol: 'INTC', stance: -1, conviction: 0.7 },
      { symbol: 'AMD', stance: 0, conviction: 0.2 },
    ];
    const text = buildSummary(signals, { since, until });
    expect(text).toMatch(/2 bullish/i);
    expect(text).toMatch(/1 bearish/i);
    expect(text).toMatch(/1 hold/i);
  });

  it('lists top calls by conviction, strongest first', () => {
    const signals = [
      { symbol: 'MU', stance: 1, conviction: 0.55 },
      { symbol: 'NVDA', stance: 2, conviction: 0.92 },
    ];
    const text = buildSummary(signals, { since, until });
    const nvdaIdx = text.indexOf('NVDA');
    const muIdx = text.indexOf('MU');
    expect(nvdaIdx).toBeGreaterThan(-1);
    expect(nvdaIdx).toBeLessThan(muIdx); // NVDA (higher conviction) listed first
  });

  it('excludes HOLD signals from the top-calls list', () => {
    const signals = [{ symbol: 'AMD', stance: 0, conviction: 0.99 }];
    const text = buildSummary(signals, { since, until });
    expect(text).not.toMatch(/AMD .*BUY|AMD .*SELL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/summary/build.test.js`
Expected: FAIL — `Cannot find module '../../src/summary/build.js'`

- [ ] **Step 3: Implement**

```js
// src/summary/build.js
const LABEL = {
  '-2': 'STRONG SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG BUY',
};

function hhmm(ts) {
  return new Date(ts).toISOString().slice(11, 16);
}

export function buildSummary(signals, { since, until }) {
  const header = `*Legion digest* — ${hhmm(since)}–${hhmm(until)} UTC`;
  if (signals.length === 0) {
    return `${header}\n\nNo signals this window.`;
  }

  const bullish = signals.filter((s) => s.stance > 0).length;
  const bearish = signals.filter((s) => s.stance < 0).length;
  const hold = signals.filter((s) => s.stance === 0).length;

  const counts = `${bullish} bullish · ${bearish} bearish · ${hold} hold`;

  const topCalls = signals
    .filter((s) => s.stance !== 0)
    .sort((a, b) => b.conviction - a.conviction)
    .slice(0, 10)
    .map((s) => `• *${s.symbol}* ${LABEL[s.stance]} (${(s.conviction * 100).toFixed(0)}%)`)
    .join('\n');

  const body = topCalls ? `\n\n${topCalls}` : '';
  return `${header}\n${counts}${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/summary/build.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/summary/build.js test/summary/build.test.js
git commit -m "feat(legion): add 6h signal summary builder"
```

---

### Task 2: Repo — signals window query

**Files:**

- Modify: `src/db/repo.js`
- Test: `test/db/repo-summary.test.js`

`listSignalsSince(since)` returns every signal with `created_at >= since`, newest first. Fake-pool test (Phase 3/4 pattern).

- [ ] **Step 1: Write the failing test**

```js
// test/db/repo-summary.test.js
import { describe, it, expect } from 'vitest';
import { createRepo } from '../../src/db/repo.js';

function fakePool(rows) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

describe('listSignalsSince', () => {
  it('selects signals created on/after the cutoff, newest first', async () => {
    const pool = fakePool([
      { symbol: 'NVDA', stance: 2, conviction: 0.9, created_at: '2026-06-04T05:00:00Z' },
    ]);
    const repo = createRepo(pool);
    const out = await repo.listSignalsSince('2026-06-04T00:00:00Z');
    expect(out).toHaveLength(1);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('from legion.signals');
    expect(text.toLowerCase()).toContain('created_at >=');
    expect(text.toLowerCase()).toContain('order by created_at desc');
    expect(params).toEqual(['2026-06-04T00:00:00Z']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo-summary.test.js`
Expected: FAIL — `repo.listSignalsSince is not a function`

- [ ] **Step 3: Add the method**

Add to the object returned by `createRepo` in `src/db/repo.js`:

```js
  async listSignalsSince(since) {
    const { rows } = await pool.query(
      `SELECT symbol, stance, conviction, created_at
         FROM legion.signals
        WHERE created_at >= $1
        ORDER BY created_at DESC`,
      [since],
    );
    return rows;
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/repo-summary.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js test/db/repo-summary.test.js
git commit -m "feat(legion): add listSignalsSince repo query"
```

---

### Task 3: Summary runner + cron entrypoint

**Files:**

- Modify: `config/index.js` (add `summaryCron`, `summaryWindowHours`)
- Create: `src/run/summary.js`
- Test: `test/run/summary-runner.test.js`

`runSummaryOnce({ repo, telegram, clock, windowHours })` computes `since = now − windowHours`, pulls signals, builds the digest, sends it. Returns `{ sent, count }`. Cron wiring mirrors the Phase 4 reliability runner (`--now` flag).

- [ ] **Step 1: Write the failing test**

```js
// test/run/summary-runner.test.js
import { describe, it, expect } from 'vitest';
import { runSummaryOnce } from '../../src/run/summary.js';

describe('runSummaryOnce', () => {
  it('queries the window, builds a digest, and sends it', async () => {
    const queried = [];
    const sent = [];
    const repo = {
      listSignalsSince: async (since) => {
        queried.push(since);
        return [{ symbol: 'NVDA', stance: 2, conviction: 0.9 }];
      },
    };
    const telegram = { send: async (text) => sent.push(text) };
    const out = await runSummaryOnce({
      repo,
      telegram,
      clock: () => new Date('2026-06-04T06:00:00Z'),
      windowHours: 6,
    });
    expect(queried[0]).toBe('2026-06-04T00:00:00.000Z'); // 6h before
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/NVDA/);
    expect(out).toEqual({ sent: true, count: 1 });
  });

  it('still sends a no-signals digest on an empty window', async () => {
    const sent = [];
    const repo = { listSignalsSince: async () => [] };
    const telegram = { send: async (t) => sent.push(t) };
    const out = await runSummaryOnce({
      repo,
      telegram,
      clock: () => new Date('2026-06-04T06:00:00Z'),
      windowHours: 6,
    });
    expect(sent[0]).toMatch(/no signals/i);
    expect(out).toEqual({ sent: true, count: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run/summary-runner.test.js`
Expected: FAIL — `Cannot find module '../../src/run/summary.js'`

- [ ] **Step 3: Add config, then implement the runner**

In `config/index.js` add to the exported config object:

```js
  summaryCron: process.env.LEGION_SUMMARY_CRON ?? '0 */6 * * *',
  summaryWindowHours: Number(process.env.LEGION_SUMMARY_WINDOW_HOURS ?? 6),
```

```js
// src/run/summary.js
import cron from 'node-cron';
import { buildSummary } from '../summary/build.js';

export async function runSummaryOnce({
  repo,
  telegram,
  clock = () => new Date(),
  windowHours = 6,
}) {
  const until = clock();
  const since = new Date(until.getTime() - windowHours * 3600000);
  const signals = await repo.listSignalsSince(since.toISOString());
  const text = buildSummary(signals, { since: since.toISOString(), until: until.toISOString() });
  await telegram.send(text);
  return { sent: true, count: signals.length };
}

async function main() {
  const { createPool } = await import('../db/pool.js');
  const { createRepo } = await import('../db/repo.js');
  const { createTelegram } = await import('../clients/telegram.js');
  const { config } = await import('../../config/index.js');

  const repo = createRepo(createPool());
  const telegram = createTelegram(config.telegram);
  const runner = () =>
    runSummaryOnce({ repo, telegram, windowHours: config.summaryWindowHours })
      .then((s) => console.info(`summary sent: ${s.count} signals`))
      .catch((err) => console.error('summary run failed:', err.message));

  if (process.argv.includes('--now')) {
    await runner();
    process.exit(0);
  }
  cron.schedule(config.summaryCron, runner);
  console.info(`summary runner scheduled: ${config.summaryCron}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

> `createTelegram(config.telegram)` is the Phase 1 client factory; reuse the exact import path/name used by the Phase 1 emitter entrypoint. If Phase 1 exported it differently (e.g. `sendTelegram`), match that — the runner only needs an object with `send(text)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/run/summary-runner.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add config/index.js src/run/summary.js test/run/summary-runner.test.js
git commit -m "feat(legion): add 6h Telegram summary runner"
```

---

### Task 4: Agent-config schema + repo methods

**Files:**

- Create: `migrations/phase5_agent_config.sql`
- Modify: `src/db/repo.js`
- Test: `test/db/repo-agent-config.test.js`

Per-agent provider/model persisted so the UI can switch them. `enabled` lets the UI mute an agent without redeploy (the agent factory checks it at cycle start — wired in Task 5).

- [ ] **Step 1: Write the failing test**

```js
// test/db/repo-agent-config.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRepo } from '../../src/db/repo.js';

const sql = readFileSync(
  fileURLToPath(new URL('../../migrations/phase5_agent_config.sql', import.meta.url)),
  'utf8',
).toLowerCase();

function fakePool(rows) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    },
  };
}

describe('phase5 migration', () => {
  it('creates legion.agent_config with provider, model, enabled', () => {
    expect(sql).toContain('create table if not exists legion.agent_config');
    expect(sql).toContain('provider');
    expect(sql).toContain('model');
    expect(sql).toContain('enabled');
  });
});

describe('agent_config repo', () => {
  it('getAllAgentConfig maps rows to a keyed object', async () => {
    const pool = fakePool([
      { agent_id: 'technical', provider: 'local', model: 'qwen2.5:7b', enabled: true },
      { agent_id: 'news', provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
    ]);
    const repo = createRepo(pool);
    const cfg = await repo.getAllAgentConfig();
    expect(cfg.technical).toEqual({ provider: 'local', model: 'qwen2.5:7b', enabled: true });
    expect(cfg.news.provider).toBe('gemini');
  });

  it('getAgentConfig returns one row or null', async () => {
    const repo = createRepo(
      fakePool([{ agent_id: 'technical', provider: 'local', model: 'm', enabled: true }]),
    );
    const cfg = await repo.getAgentConfig('technical');
    expect(cfg).toEqual({ provider: 'local', model: 'm', enabled: true });
    const repo2 = createRepo(fakePool([]));
    expect(await repo2.getAgentConfig('missing')).toBeNull();
  });

  it('upsertAgentConfig upserts provider/model/enabled', async () => {
    const pool = fakePool([]);
    const repo = createRepo(pool);
    await repo.upsertAgentConfig('technical', {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      enabled: false,
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.agent_config');
    expect(text.toLowerCase()).toContain('on conflict');
    expect(params).toEqual(['technical', 'gemini', 'gemini-2.5-flash', false]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo-agent-config.test.js`
Expected: FAIL — `ENOENT ... migrations/phase5_agent_config.sql`

- [ ] **Step 3: Write migration + repo methods**

```sql
-- migrations/phase5_agent_config.sql
CREATE TABLE IF NOT EXISTS legion.agent_config (
  agent_id   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT 'local',
  model      TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Add to `src/db/repo.js`:

```js
  async getAllAgentConfig() {
    const { rows } = await pool.query(
      `SELECT agent_id, provider, model, enabled FROM legion.agent_config`,
    );
    return Object.fromEntries(
      rows.map((r) => [r.agent_id, { provider: r.provider, model: r.model, enabled: r.enabled }]),
    );
  },

  async getAgentConfig(agentId) {
    const { rows } = await pool.query(
      `SELECT provider, model, enabled FROM legion.agent_config WHERE agent_id = $1`,
      [agentId],
    );
    if (!rows[0]) return null;
    return { provider: rows[0].provider, model: rows[0].model, enabled: rows[0].enabled };
  },

  async upsertAgentConfig(agentId, { provider, model, enabled }) {
    await pool.query(
      `INSERT INTO legion.agent_config (agent_id, provider, model, enabled, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (agent_id) DO UPDATE
         SET provider = EXCLUDED.provider, model = EXCLUDED.model,
             enabled = EXCLUDED.enabled, updated_at = now()`,
      [agentId, provider, model, enabled],
    );
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/repo-agent-config.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Apply migration**

Run: `node src/db/migrate.js`
Expected: applies cleanly; idempotent on re-run.

- [ ] **Step 6: Commit**

```bash
git add migrations/phase5_agent_config.sql src/db/repo.js test/db/repo-agent-config.test.js
git commit -m "feat(legion): add per-agent provider config storage"
```

---

### Task 5: Provider router + per-cycle provider in the agent factory

**Files:**

- Modify: `src/llm/provider.js` (add `resolveProvider`, `DEFAULT_MODELS`)
- Modify: `src/agents/factory.js` (optional `getProvider` per cycle; respect `enabled`)
- Test: `test/llm/resolve-provider.test.js`, `test/agents/factory-provider.test.js`

`resolveProvider({ provider, model })` maps a provider name to a concrete provider instance via the existing `createProvider` factory (Phase 0), filling in `DEFAULT_MODELS[provider]` when `model` is null. The agent factory gains an optional `getProvider({ agentId })` callback invoked **per cycle**, so a UI change takes effect on the next evaluation without redeploy; if the resolved config has `enabled: false`, the agent abstains (HOLD/0) without calling the LLM. Back-compatible: when `getProvider` is omitted, the injected `provider` is used exactly as in Phase 2.

- [ ] **Step 1: Write the failing tests**

```js
// test/llm/resolve-provider.test.js
import { describe, it, expect, vi } from 'vitest';
import { resolveProvider, DEFAULT_MODELS } from '../../src/llm/provider.js';

describe('resolveProvider', () => {
  it('fills the default model when none is given', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'local', model: null }, fakeFactory);
    expect(calls[0]).toEqual({ type: 'local', model: DEFAULT_MODELS.local });
  });

  it('passes an explicit model through', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'gemini', model: 'gemini-2.5-pro' }, fakeFactory);
    expect(calls[0]).toEqual({ type: 'gemini', model: 'gemini-2.5-pro' });
  });

  it('defaults to local for an unknown provider name', () => {
    const calls = [];
    const fakeFactory = (opts) => {
      calls.push(opts);
      return { generate: async () => '' };
    };
    resolveProvider({ provider: 'bogus', model: null }, fakeFactory);
    expect(calls[0].type).toBe('local');
  });
});
```

```js
// test/agents/factory-provider.test.js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createAgent } from '../../src/agents/factory.js';
import { cycleSubject, voteSubject } from '../../src/bus/subjects.js';

function baseDeps(overrides = {}) {
  return {
    id: 'technical',
    weight: 1.0,
    gather: async () => ({}),
    buildPrompt: () => 'prompt',
    bus: createMemoryBus(),
    gunvest: {},
    logger: { info() {}, error() {} },
    ...overrides,
  };
}

describe('factory per-cycle provider', () => {
  it('uses getProvider(agentId) when supplied', async () => {
    const used = [];
    const provider = { generate: async () => '{"stance":1,"conviction":0.7,"rationale":"r"}' };
    const deps = baseDeps({
      getProvider: async ({ agentId }) => {
        used.push(agentId);
        return { provider, enabled: true };
      },
    });
    const published = [];
    deps.bus.subscribe(voteSubject('NVDA', 1), (m) => published.push(m));
    const agent = createAgent(deps);
    await agent.start();
    await deps.bus.publish(cycleSubject('NVDA'), { cycleId: 1, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(used).toEqual(['technical']);
    expect(published[0].vote.stance).toBe(1);
  });

  it('abstains (HOLD/0) without calling the LLM when disabled', async () => {
    let generated = false;
    const provider = {
      generate: async () => {
        generated = true;
        return '';
      },
    };
    const deps = baseDeps({
      getProvider: async () => ({ provider, enabled: false }),
    });
    const published = [];
    deps.bus.subscribe(voteSubject('NVDA', 1), (m) => published.push(m));
    const agent = createAgent(deps);
    await agent.start();
    await deps.bus.publish(cycleSubject('NVDA'), { cycleId: 1, symbol: 'NVDA', round: 1 });
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(generated).toBe(false);
    expect(published[0].vote.stance).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/llm/resolve-provider.test.js test/agents/factory-provider.test.js`
Expected: FAIL — `resolveProvider` undefined / factory ignores `getProvider`.

- [ ] **Step 3: Implement**

In `src/llm/provider.js`, add (keep the existing `createProvider` export):

```js
export const DEFAULT_MODELS = {
  local: 'qwen2.5:7b',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
};

export function resolveProvider({ provider, model } = {}, factory = createProvider) {
  const type = DEFAULT_MODELS[provider] ? provider : 'local';
  return factory({ type, model: model ?? DEFAULT_MODELS[type] });
}
```

In `src/agents/factory.js`, update the cycle handler. The Phase 2 factory used an injected `provider` and produced a vote. Add the optional `getProvider` path:

```js
export function createAgent({
  id,
  weight,
  gather,
  buildPrompt,
  bus,
  gunvest,
  provider = null,
  getProvider = null,
  logger = console,
}) {
  async function onCycle(msg) {
    const { cycleId, symbol, round, priorVotes = [] } = msg;
    try {
      let activeProvider = provider;
      if (getProvider) {
        const resolved = await getProvider({ agentId: id });
        if (resolved && resolved.enabled === false) {
          await publishVote(bus, symbol, round, abstain(cycleId, symbol, round, id, weight));
          return;
        }
        activeProvider = resolved?.provider ?? provider;
      }

      const data = await gather(gunvest, symbol);
      const peers = summarizePeers(priorVotes, id);
      const prompt = buildPrompt(symbol, data, peers);
      const text = await activeProvider.generate(prompt);
      const { ok, vote } = parseVote(text, { agentId: id, weight });
      const finalVote = ok
        ? vote
        : { agentId: id, stance: 0, conviction: 0, weight, rationale: 'parse-failed abstain' };
      await publishVote(bus, symbol, round, { cycleId, symbol, round, vote: finalVote });
    } catch (err) {
      logger.error?.(`agent ${id} cycle failed for ${symbol}: ${err.message}`);
      await publishVote(bus, symbol, round, abstain(cycleId, symbol, round, id, weight));
    }
  }

  return {
    async start() {
      await bus.subscribe(cycleWildcard(), onCycle);
    },
  };
}

function abstain(cycleId, symbol, round, id, weight) {
  return {
    cycleId,
    symbol,
    round,
    vote: { agentId: id, stance: 0, conviction: 0, weight, rationale: 'abstain' },
  };
}

async function publishVote(bus, symbol, round, envelope) {
  await bus.publish(voteSubject(symbol, round), envelope);
}
```

> Reuse the Phase 2 imports already at the top of `factory.js` (`summarizePeers`, `parseVote`, `cycleWildcard`, `voteSubject`). The only behavioral changes are the `getProvider` branch and the `enabled === false` short-circuit; the injected-`provider` path is byte-for-byte the Phase 2 behavior, so Phase 2 factory tests stay green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/llm/resolve-provider.test.js test/agents/factory-provider.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full agents suite for regressions**

Run: `npx vitest run test/agents/`
Expected: PASS — Phase 2 factory + agent tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/llm/provider.js src/agents/factory.js test/llm/resolve-provider.test.js test/agents/factory-provider.test.js
git commit -m "feat(legion): add runtime per-agent provider switching"
```

---

### Task 6: Agents config API

**Files:**

- Create: `src/api/routes/agents.js`
- Modify: `src/api/app.js` (mount router)
- Test: `test/api/agents.test.js`

`GET /api/agents` → merged static prior weight + persisted config per agent. `PATCH /api/agents/:id` → upsert `{ provider, model, enabled }` (validates provider name; 400 on unknown provider, 404 on unknown agent id). The static roster (ids + `w_i`) comes from the existing agent registry/config; the route overlays DB config on top.

- [ ] **Step 1: Write the failing test**

```js
// test/api/agents.test.js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(initial = {}) {
  const store = { ...initial };
  return {
    getAllAgentConfig: async () => store,
    upsertAgentConfig: async (id, cfg) => {
      store[id] = cfg;
    },
    _store: store,
  };
}

describe('GET /api/agents', () => {
  it('returns the roster merged with persisted config', async () => {
    const repo = repoStub({
      technical: { provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
    });
    const res = await request(createApp({ repo })).get('/api/agents');
    expect(res.status).toBe(200);
    const tech = res.body.find((a) => a.id === 'technical');
    expect(tech.provider).toBe('gemini');
    expect(tech.weight).toBeGreaterThan(0); // static prior present
    const news = res.body.find((a) => a.id === 'news');
    expect(news.provider).toBe('local'); // default when no row
  });
});

describe('PATCH /api/agents/:id', () => {
  it('upserts a valid provider change', async () => {
    const repo = repoStub();
    const res = await request(createApp({ repo }))
      .patch('/api/agents/technical')
      .send({ provider: 'gemini', model: 'gemini-2.5-flash', enabled: true });
    expect(res.status).toBe(200);
    expect(repo._store.technical.provider).toBe('gemini');
  });

  it('rejects an unknown provider with 400', async () => {
    const res = await request(createApp({ repo: repoStub() }))
      .patch('/api/agents/technical')
      .send({ provider: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown agent id with 404', async () => {
    const res = await request(createApp({ repo: repoStub() }))
      .patch('/api/agents/nonexistent')
      .send({ provider: 'local' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/agents.test.js`
Expected: FAIL — 404 (router not mounted).

- [ ] **Step 3: Implement the router**

```js
// src/api/routes/agents.js
import { Router } from 'express';
import { DEFAULT_MODELS } from '../../llm/provider.js';

// Static roster (ids + prior weights) — mirrors the launch config in the spec.
export const ROSTER = [
  { id: 'technical', weight: 1.0 },
  { id: 'news', weight: 1.2 },
  { id: 'social', weight: 0.8 },
  { id: 'contrarian', weight: 0.9 },
];

const VALID_PROVIDERS = new Set(Object.keys(DEFAULT_MODELS));

export function agentsRouter(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const cfg = await repo.getAllAgentConfig();
      res.json(
        ROSTER.map((a) => ({
          ...a,
          provider: cfg[a.id]?.provider ?? 'local',
          model: cfg[a.id]?.model ?? null,
          enabled: cfg[a.id]?.enabled ?? true,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!ROSTER.some((a) => a.id === id)) {
        return res.status(404).json({ error: `unknown agent: ${id}` });
      }
      const { provider = 'local', model = null, enabled = true } = req.body ?? {};
      if (!VALID_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: `unknown provider: ${provider}` });
      }
      await repo.upsertAgentConfig(id, { provider, model, enabled });
      res.json({ id, provider, model, enabled });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

Mount in `src/api/app.js`:

```js
import { agentsRouter } from './routes/agents.js';
// inside createApp:
app.use('/api/agents', agentsRouter(repo));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api/agents.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Run full API suite**

Run: `npx vitest run test/api/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/agents.js src/api/app.js test/api/agents.test.js
git commit -m "feat(legion): add agent provider config API"
```

---

### Task 7: Web — provider-switch UI

**Files:**

- Modify: `web/src/api/client.js` (add `listAgents`, `setAgent`)
- Create: `web/src/pages/AgentConfig.jsx`
- Modify: `web/src/App.jsx` (add "Agents" tab)
- Test: `web/test/AgentConfig.test.jsx`

Lists each agent with a provider dropdown (local/gemini/openai), a model text field, and an enabled toggle; saving calls `PATCH /api/agents/:id` and reflects the change.

- [ ] **Step 1: Write the failing test**

```jsx
// web/test/AgentConfig.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AgentConfig from '../src/pages/AgentConfig.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('AgentConfig', () => {
  it('renders one row per agent with its provider selected', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([
      { id: 'technical', weight: 1.0, provider: 'local', model: null, enabled: true },
      { id: 'news', weight: 1.2, provider: 'gemini', model: 'gemini-2.5-flash', enabled: true },
    ]);
    render(<AgentConfig />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    const select = screen.getByLabelText('provider-news');
    expect(select.value).toBe('gemini');
  });

  it('saves a provider change via setAgent', async () => {
    vi.spyOn(api, 'listAgents').mockResolvedValue([
      { id: 'technical', weight: 1.0, provider: 'local', model: null, enabled: true },
    ]);
    const setAgent = vi.spyOn(api, 'setAgent').mockResolvedValue({});
    render(<AgentConfig />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('provider-technical'), { target: { value: 'gemini' } });
    fireEvent.click(screen.getByLabelText('save-technical'));
    await waitFor(() =>
      expect(setAgent).toHaveBeenCalledWith(
        'technical',
        expect.objectContaining({ provider: 'gemini' }),
      ),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/AgentConfig.test.jsx`
Expected: FAIL — page module not found.

- [ ] **Step 3: Add client methods + page**

In `web/src/api/client.js`, add to the `api` object:

```js
  listAgents: () => get('/api/agents'),
  setAgent: (id, cfg) => patch(`/api/agents/${id}`, cfg),
```

If Phase 3's client has no `patch` helper, add one next to the existing `get`/`post`:

```js
async function patch(path, body) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API PATCH ${path} failed: ${res.status}`);
  return res.json();
}
```

```jsx
// web/src/pages/AgentConfig.jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

const PROVIDERS = ['local', 'gemini', 'openai'];

export default function AgentConfig() {
  const [agents, setAgents] = useState([]);

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  function update(id, patch) {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  async function save(a) {
    await api.setAgent(a.id, { provider: a.provider, model: a.model, enabled: a.enabled });
  }

  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b">
          <th className="p-2">Agent</th>
          <th className="p-2">Weight</th>
          <th className="p-2">Provider</th>
          <th className="p-2">Model</th>
          <th className="p-2">Enabled</th>
          <th className="p-2"></th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.id} className="border-b">
            <td className="p-2 font-medium">{a.id}</td>
            <td className="p-2 text-gray-500">{a.weight}</td>
            <td className="p-2">
              <select
                aria-label={`provider-${a.id}`}
                value={a.provider}
                onChange={(e) => update(a.id, { provider: e.target.value })}
                className="border rounded px-1 py-0.5"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </td>
            <td className="p-2">
              <input
                aria-label={`model-${a.id}`}
                value={a.model ?? ''}
                placeholder="(default)"
                onChange={(e) => update(a.id, { model: e.target.value || null })}
                className="border rounded px-1 py-0.5 w-40"
              />
            </td>
            <td className="p-2">
              <input
                aria-label={`enabled-${a.id}`}
                type="checkbox"
                checked={a.enabled}
                onChange={(e) => update(a.id, { enabled: e.target.checked })}
              />
            </td>
            <td className="p-2">
              <button
                aria-label={`save-${a.id}`}
                onClick={() => save(a)}
                className="bg-blue-600 text-white rounded px-2 py-0.5"
              >
                Save
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Wire the tab into `web/src/App.jsx`**

```jsx
import AgentConfig from './pages/AgentConfig.jsx';
// add to the tab list:
//   { id: 'agents', label: 'Agents', render: () => <AgentConfig /> }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run test/AgentConfig.test.jsx`
Expected: PASS (2 tests)

- [ ] **Step 6: Manual browser check**

Start API + web (Phase 3 instructions). Open **Agents** tab → change Technical's provider to `gemini`, Save → confirm `PATCH /api/agents/technical` returns 200 (network tab) and the row persists on reload. No console errors. If you cannot run the stack, say so explicitly.

- [ ] **Step 7: Commit**

```bash
git add web/src/api/client.js web/src/pages/AgentConfig.jsx web/src/App.jsx web/test/AgentConfig.test.jsx
git commit -m "feat(legion): add provider-switch dashboard page"
```

---

### Task 8: Contributor guide — adding an agent

**Files:**

- Create: `docs/adding-an-agent.md`
- Test: `test/docs/adding-an-agent.test.js`

A light test asserts the guide documents the four required module parts and the registration steps — so the doc can't silently rot to a stub.

- [ ] **Step 1: Write the failing test**

```js
// test/docs/adding-an-agent.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = readFileSync(
  fileURLToPath(new URL('../../docs/adding-an-agent.md', import.meta.url)),
  'utf8',
).toLowerCase();

describe('adding-an-agent guide', () => {
  it('documents the four module parts', () => {
    for (const part of ['config', 'gather', 'prompt', 'index']) {
      expect(doc).toContain(part);
    }
  });
  it('explains the prior weight and roster registration', () => {
    expect(doc).toContain('weight');
    expect(doc).toContain('roster');
  });
  it('covers consensus impact (N changes f and quorum)', () => {
    expect(doc).toContain('quorum');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docs/adding-an-agent.test.js`
Expected: FAIL — `ENOENT ... docs/adding-an-agent.md`

- [ ] **Step 3: Write the guide**

```markdown
<!-- docs/adding-an-agent.md -->

# Adding a Legion Agent

A Legion agent is one process built from four small parts plus a roster entry. The
consensus core never changes — agents are pure data + a persona.

## 1. The four module parts

Create `src/agents/<name>/`:

| File        | Responsibility                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `config.js` | Exports `{ id, weight }` — the agent id and its static prior weight `w_i`.                                            |
| `gather.js` | Exports `gather(gunvest, symbol)` → a plain data object pulled from GunVest endpoints. No LLM, no consensus.          |
| `prompt.js` | Exports `buildPrompt(symbol, data, peers)` → the persona + `RESPONSE_SPEC` + optional `dissentBlock(peers)`.          |
| `index.js`  | Wires the above into `createAgent({ id, weight, gather, buildPrompt, bus, gunvest, getProvider })` and `start()`s it. |

Reuse `src/agents/format.js` (`RESPONSE_SPEC`, `dissentBlock`) and `src/agents/parse.js`
(`parseVote`) — do not re-implement the JSON contract or parsing.

## 2. Register in the roster

Add `{ id: '<name>', weight: <w_i> }` to `ROSTER` in `src/api/routes/agents.js` and add a
run entrypoint `src/run/agent-<name>.js` plus a service in `docker-compose.yml`
(copy an existing agent service, change the command).

Set `expectedAgents` in the emitter env to the new voting-agent count so the emitter waits
for every vote before aggregating.

## 3. Weight and reliability

`weight` is the static prior `w_i`. Effective weight is `W_i = w_i · ρ_i`, where `ρ_i`
starts at 1.0 and is tuned by the Phase 4 Brier loop once the agent's signals resolve.
Pick `w_i` ≈ 1.0; raise it only if the agent's domain is unusually load-bearing.

## 4. Consensus impact

Adding a voting agent changes `N`, which changes fault tolerance `f = ⌊(N−1)/3⌋` and the
quorum threshold `κ ≥ 2/3`. Going from 4 → 5 voting agents raises the agreeing-weight
needed for the 2/3 directional **quorum** and changes how many outliers the gestalt
tolerates. Prefer odd `N` to avoid ties at the band edge. Re-check `θ_v` (dispersion cap)
after adding an agent whose stance distribution is wide.

## 5. Provider

The agent inherits per-agent provider switching for free via `getProvider({ agentId })`
(Phase 5). Its default provider is `local`; change it at runtime on the **Agents** tab.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docs/adding-an-agent.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add docs/adding-an-agent.md test/docs/adding-an-agent.test.js
git commit -m "docs(legion): add contributor guide for adding an agent"
```

---

### Task 9: Architecture Decision Records

**Files:**

- Create: `docs/adr/0001-consensus-protocol.md`
- Create: `docs/adr/0002-message-bus.md`
- Create: `docs/adr/0003-inference-abstraction.md`
- Create: `docs/adr/0004-deployment.md`
- Test: `test/docs/adr.test.js`

One test asserts all four ADRs exist and use the standard Context/Decision/Consequences structure.

- [ ] **Step 1: Write the failing test**

```js
// test/docs/adr.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const files = [
  '0001-consensus-protocol',
  '0002-message-bus',
  '0003-inference-abstraction',
  '0004-deployment',
];

describe('ADRs', () => {
  for (const f of files) {
    it(`${f} has Context, Decision, Consequences`, () => {
      const md = readFileSync(
        fileURLToPath(new URL(`../../docs/adr/${f}.md`, import.meta.url)),
        'utf8',
      ).toLowerCase();
      expect(md).toContain('## context');
      expect(md).toContain('## decision');
      expect(md).toContain('## consequences');
      expect(md).toContain('## status');
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docs/adr.test.js`
Expected: FAIL — ADR files missing.

- [ ] **Step 3: Write the four ADRs**

```markdown
<!-- docs/adr/0001-consensus-protocol.md -->

# ADR 0001 — BFT-flavored Leaderless Consensus

## Status

Accepted (2026-06-04).

## Context

Legion must reach a single trade stance from N independent expert agents with no prime
decider, must tolerate a rogue/outlier agent, and must be deterministic so every node
computes the same result from the same votes. True adversarial PBFT is overkill: agents are
cooperative and co-located.

## Decision

Adopt a BFT-_flavored_ aggregation computed identically by every node. Each agent emits an
ordinal stance `s_i ∈ [-2,2]`, conviction `c_i ∈ [0,1]`, and rationale. Effective weight
`W_i = w_i · ρ_i`. Per round compute weighted stance `S_r`, weighted dispersion `V_r`, and
directional quorum `κ_r`. Converge iff `κ_r ≥ 2/3` AND `V_r ≤ θ_v` (default 0.5). Fault
tolerance `f = ⌊(N−1)/3⌋`. Up to `R_max = 3` rounds with forced dissent exposure between
rounds; unconverged → `NO_CONSENSUS`/HOLD.

## Consequences

- No leader, no single point of decision; consensus is verifiable from the vote log.
- A lone outlier can neither force nor block a signal (with N=4, need 3 agreeing).
- Honest "split" outcomes are preserved instead of forcing a trade.
- ρ_i (Brier-tuned) lets the gestalt learn whom to trust over time.
- Cost: multi-round iteration multiplies LLM calls (bounded by R_max).
```

```markdown
<!-- docs/adr/0002-message-bus.md -->

# ADR 0002 — NATS Message Bus with In-Memory Test Double

## Status

Accepted (2026-06-04).

## Context

Five agent processes plus orchestrator, risk, and emitter must communicate via pub/sub with
subject wildcards, run on a single Always-Free VM, and be testable without standing
infrastructure.

## Decision

Use NATS (lightweight, Docker, subject wildcards `*`/`>`) as the runtime bus. Define an
`src/bus/` abstraction (`subjects.js`, a NATS adapter, and `memory.js` — an in-memory bus
implementing the same `publish`/`subscribe` contract with NATS-style wildcard matching).
Integration tests run against the in-memory double; production wires NATS.

## Consequences

- Infra-free, deterministic tests for orchestration, agents, and the emitter.
- One contract, two implementations — production behavior is exercised by the same code paths.
- NATS adds one container; acceptable on the A1 VM.
- Risk: the memory double could drift from NATS semantics — mitigated by sharing the subject
  helpers and a wildcard-matching test suite.
```

```markdown
<!-- docs/adr/0003-inference-abstraction.md -->

# ADR 0003 — Pluggable LLM Provider Abstraction

## Status

Accepted (2026-06-04).

## Context

Runtime cost must be ≈$0 by default, but accuracy sometimes warrants a hosted model. Each
agent may want a different provider, and operators should switch without redeploying.

## Decision

A `src/llm/provider.js` factory exposes `createProvider({ type, model })` for `local`
(Ollama, default), `gemini`, and `openai`, all behind a `generate(prompt)` interface.
`resolveProvider({ provider, model })` fills `DEFAULT_MODELS` and defaults unknown names to
`local`. Per-agent provider/model live in `legion.agent_config` and are resolved **per
cycle** by the agent factory's `getProvider({ agentId })`, so a UI change takes effect on the
next evaluation. Disabled agents abstain without an LLM call.

## Consequences

- Default deploy is free (local Ollama); paid providers are strictly opt-in per agent.
- Operators tune cost/accuracy live from the dashboard.
- Local ARM inference is slow (~5–10 tok/s) — acceptable for batch cadence.
- Adding a provider = one branch in the factory + a default model entry.
```

```markdown
<!-- docs/adr/0004-deployment.md -->

# ADR 0004 — Single-VM Docker Deployment on Oracle A1

## Status

Accepted (2026-06-04).

## Context

The project targets ≈$0 runtime. Available free infra: an Oracle Cloud A1 Always-Free VM
(6 vCPU ARM, 24 GB RAM) and the GunVest PostgreSQL instance.

## Decision

Deploy everything as Docker Compose services on the one A1 VM: NATS, one Ollama container
(serial throughput), the orchestrator, voting agents, risk, emitter, API, web, and the
reliability/summary runners. Share GunVest's Postgres via an isolated `legion` schema; use
GunVest's REST API as the sole data source and its Telegram bot for delivery. The deterministic
backtest is a one-shot CLI, not a long-lived service.

## Consequences

- Zero incremental infra cost.
- Serial Ollama throughput → ~12–15 min/ticker cycle; fine for 6h batch cadence.
- Single VM is a single point of failure; advisory-only output makes this acceptable.
- Scaling to many tickers/agents later may require a second model server (deferred).
- GunVest stays the source of truth; Legion never re-implements data fetching.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docs/adr.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ test/docs/adr.test.js
git commit -m "docs(legion): add ADRs for consensus, bus, inference, deployment"
```

---

### Task 10: Polish — summary service, README, full-suite gate

**Files:**

- Modify: `docker-compose.yml` (add `summary` service)
- Modify: `README.md` (Phase 5 section)

- [ ] **Step 1: Add the `summary` service to `docker-compose.yml`**

```yaml
summary:
  build: .
  command: node src/run/summary.js
  env_file: .env
  depends_on:
    - api
  restart: unless-stopped
```

- [ ] **Step 2: Add a Phase 5 section to `README.md`**

```markdown
## Phase 5 — Summary, provider switching, docs

- **6h Telegram digest:** `src/run/summary.js` (cron `LEGION_SUMMARY_CRON`, default `0 */6 * * *`).
  Run once: `node src/run/summary.js --now`.
- **Per-agent provider switching:** dashboard **Agents** tab → set provider (`local`/`gemini`/`openai`)
  and model per agent; persisted in `legion.agent_config`, applied on the next cycle. Disabled agents abstain.
- **Add an agent:** see `docs/adding-an-agent.md`.
- **Architecture decisions:** `docs/adr/0001`–`0004`.

### Environment

| Var                           | Default       | Meaning          |
| ----------------------------- | ------------- | ---------------- |
| `LEGION_SUMMARY_CRON`         | `0 */6 * * *` | digest schedule  |
| `LEGION_SUMMARY_WINDOW_HOURS` | `6`           | digest look-back |
```

- [ ] **Step 3: Run the entire backend suite**

Run: `npx vitest run`
Expected: PASS — all phases (0–5) green.

- [ ] **Step 4: Run the entire web suite**

Run: `cd web && npx vitest run`
Expected: PASS — all web tests green.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "chore(legion): add summary service and Phase 5 docs"
```

---

## Phase 5 — Done. Handover notes

**Shipped:** 6h Telegram digest (pure builder + cron runner), runtime per-agent LLM provider switching (DB-backed config → resolved per cycle by the factory, with a dashboard tab and validating API), a contributor guide for adding agents, and four ADRs. README + docker-compose updated.

**Legion is feature-complete** across the six phases (0 foundation → 5 polish). The gestalt evaluates tickers leaderlessly, reaches BFT-flavored consensus, applies a deterministic risk constraint, self-tunes via Brier reliability, paper-tests and backtests itself, and is fully observable + operable from the dashboard.

**Operational notes:**

- Provider switches apply on the **next cycle**, not mid-cycle — expected, since votes within a round must use a stable provider.
- Disabling all voting agents would starve the emitter (it waits for `expectedAgents` votes). The UI does not guard against this; document it for operators or add an emitter timeout if it bites.
- The summary digest fires even on empty windows (intentional heartbeat). Flip to skip-empty by early-returning in `runSummaryOnce` if `signals.length === 0` and you'd rather stay quiet.
- `ROSTER` is duplicated as the API's static source of truth; if agent ids/weights ever move into a shared config module, point both the API route and `getProvider` wiring at it.

**Deferred (from the spec's open items, still open):** Twitter/X social source (paid), promoting Risk Manager to a voting node (config flag), parallel LLM throughput (second model server), and standalone Quant/Macro/Crowd-Fade agents — all designed as drop-ins via `docs/adding-an-agent.md`.

---

## Self-Review

**Spec coverage (§10 Phase 5 + §6/§7):** 6h Telegram summary ✓ (Tasks 1-3). Provider-switch UI ✓ (Tasks 4-7: storage → router/factory → API → page). Add-agent docs ✓ (Task 8). ADRs for consensus, message bus, inference abstraction, deployment ✓ (Task 9). Polish (compose, README, full-suite gate) ✓ (Task 10).

**Type consistency:** `getProvider({ agentId })` returns `{ provider, enabled }` ⟷ factory consumes `resolved.provider`/`resolved.enabled`. `resolveProvider({ provider, model })` ⟷ `getAgentConfig` returns `{ provider, model, enabled }`. `upsertAgentConfig(id, { provider, model, enabled })` ⟷ PATCH body ⟷ `AgentConfig.save`. `buildSummary(signals, { since, until })` ⟷ `runSummaryOnce` call site (ISO strings). `listSignalsSince(since)` ISO string ⟷ runner passes `since.toISOString()`. `DEFAULT_MODELS` keys ⟷ `VALID_PROVIDERS` ⟷ UI `PROVIDERS` array (local/gemini/openai) — aligned.

**Backward compatibility:** factory `getProvider` is optional; when absent the injected-`provider` path is byte-for-byte Phase 2, so Phase 2 factory/agent tests stay green (Task 5 Step 5 gates this). New API routers are additive; Phase 3/4 routes untouched. New repo methods are additive.

**Boundary discipline:** pure (`build.js`, `resolveProvider`) fully unit-tested with no I/O; orchestration (`runSummaryOnce`, factory) tested with stubs + in-memory bus; API data-only via supertest; web presentation-only via RTL; docs guarded by existence/structure tests so they can't rot to stubs. No DB needed for any test.

**No placeholders:** every code step has complete code; every doc step has the full file content; every step has a run command + expected result. The few "match the existing Phase N name" notes (telegram client factory import, client `patch` helper, App tab-shell shape) are explicit, bounded adaptations to already-built code, not deferred work.
