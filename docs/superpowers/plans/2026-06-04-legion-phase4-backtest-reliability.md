# Legion Phase 4 — Backtest + Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure signal quality and self-tune the gestalt: forward paper-test every emitted signal against SPY/QQQ, replay a deterministic technical sub-signal over price history, and update each agent's reliability ρ_i via Brier score so effective weight W_i = w_i · ρ_i reflects track record.

**Architecture:** Three independent, infra-free-testable pieces. (1) **Resolution** — a job marks due signals resolved with forward/benchmark returns and a binary outcome. (2) **Reliability** — a pure Brier recompute turns resolved per-agent forecasts into ρ_i, persisted to `legion.agent_reliability`; the emitter scales vote weights by ρ at aggregation time. (3) **Deterministic backtest** — a pure quant strategy (RSI/MACD/SMA, no LLM) replays over historical candles and records hit-rate + P&L vs indices. API + SPA expose a reliability leaderboard and backtest results.

**Tech Stack:** Node.js ESM, Vitest, pg (fake-pool unit tests, mirroring Phase 3), native fetch (GunVest API client), node-cron, Express + supertest (API), Vite + React 18 + Tailwind + @testing-library/react + jsdom (web). All runtime local-first, ≈$0.

---

## Design constants (single source of truth)

```
Forecast prob from a vote:   p_i = clamp(0.5 + (s_i * c_i) / 4, 0, 1)
                             (s=+2,c=1 → 1.0 ; s=-2,c=1 → 0.0 ; HOLD → 0.5)
Outcome event (alpha):       o = 1 if forward_return > spy_return else 0
Brier per forecast:          b_i = (p_i - o)^2
Reliability:                 rho = clamp(1 + 2 * (0.25 - meanBrier), 0.5, 1.5)
                             (meanBrier 0 → 1.5 ; 0.25/random → 1.0 ; 0.5 → 0.5)
Min sample before tuning:    MIN_RESOLVED = 5   (else rho = 1.0)
Reliability window:          WINDOW = 50 most-recent resolved forecasts/agent
Default signal horizon:      HORIZON_DAYS = 5
```

These live in `src/consensus/reliability.js` and `src/backtest/indicators.js` as exported constants — never inline the numbers elsewhere.

---

## File Structure

- `migrations/phase4_reliability.sql` — schema: `agent_reliability`, `signal_votes`, `backtest_results`; ALTER `signals` add resolution columns.
- `src/consensus/reliability.js` — pure: `forecastProb`, `brier`, `reliabilityFromBrier`, `scaleWeights`, constants.
- `src/reliability/resolver.js` — `returnOver`, `resolveSignals(repo, gunvest, now)`.
- `src/reliability/update.js` — `recomputeReliability(repo)`.
- `src/backtest/indicators.js` — pure: `sma`, `ema`, `rsi`, `macd`, `computeIndicators`, `quantStance`.
- `src/backtest/deterministic.js` — `runBacktest(candles, spy, qqq, opts)`.
- `src/db/repo.js` — MODIFY: reliability/resolution/backtest methods; `addSignal` gains entryPrice/horizon; `addSignalVotes`.
- `src/clients/gunvest.js` — MODIFY: `getCandles(symbol, days)`.
- `src/emit/emitter.js` — MODIFY: load reliability, scale weights, persist signal_votes + entry/horizon.
- `src/api/routes/reliability.js`, `src/api/routes/backtest.js` — NEW; mounted in `src/api/app.js`.
- `src/run/reliability.js`, `src/run/backtest.js` — NEW cron/CLI entrypoints.
- `web/src/api/client.js` — MODIFY: `getReliability`, `getBacktest`.
- `web/src/pages/ReliabilityBoard.jsx`, `web/src/pages/BacktestPage.jsx` — NEW; wired into `web/src/App.jsx`.
- `config/index.js` — MODIFY: `reliabilityCron`, `horizonDays`.
- `docker-compose.yml` — MODIFY: `reliability` service.

---

### Task 1: Reliability math (pure)

**Files:**
- Create: `src/consensus/reliability.js`
- Test: `test/consensus/reliability.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/consensus/reliability.test.js
import { describe, it, expect } from 'vitest';
import {
  forecastProb,
  brier,
  reliabilityFromBrier,
  scaleWeights,
  MIN_RESOLVED,
} from '../../src/consensus/reliability.js';

describe('forecastProb', () => {
  it('maps strong buy + full conviction to 1.0', () => {
    expect(forecastProb(2, 1)).toBeCloseTo(1.0);
  });
  it('maps strong sell + full conviction to 0.0', () => {
    expect(forecastProb(-2, 1)).toBeCloseTo(0.0);
  });
  it('maps HOLD to 0.5 regardless of conviction', () => {
    expect(forecastProb(0, 0.9)).toBeCloseTo(0.5);
  });
  it('clamps to [0,1]', () => {
    expect(forecastProb(2, 5)).toBe(1);
    expect(forecastProb(-2, 5)).toBe(0);
  });
});

describe('brier', () => {
  it('is squared error of forecast vs outcome', () => {
    expect(brier(0.8, 1)).toBeCloseTo(0.04);
    expect(brier(0.8, 0)).toBeCloseTo(0.64);
  });
});

describe('reliabilityFromBrier', () => {
  it('returns neutral 1.0 below min sample', () => {
    expect(reliabilityFromBrier(0.0, MIN_RESOLVED - 1)).toBe(1.0);
  });
  it('perfect mean Brier -> 1.5 cap', () => {
    expect(reliabilityFromBrier(0.0, 50)).toBeCloseTo(1.5);
  });
  it('random mean Brier 0.25 -> neutral 1.0', () => {
    expect(reliabilityFromBrier(0.25, 50)).toBeCloseTo(1.0);
  });
  it('anti-skill mean Brier 0.5 -> 0.5 floor', () => {
    expect(reliabilityFromBrier(0.5, 50)).toBeCloseTo(0.5);
  });
  it('clamps below floor', () => {
    expect(reliabilityFromBrier(0.9, 50)).toBe(0.5);
  });
});

describe('scaleWeights', () => {
  it('multiplies each vote weight by its agent rho, default 1.0', () => {
    const votes = [
      { agentId: 'technical', weight: 1.0, stance: 1, conviction: 0.8 },
      { agentId: 'news', weight: 1.2, stance: -1, conviction: 0.5 },
    ];
    const out = scaleWeights(votes, { technical: 1.5 });
    expect(out[0].weight).toBeCloseTo(1.5);
    expect(out[1].weight).toBeCloseTo(1.2);
  });
  it('does not mutate input', () => {
    const votes = [{ agentId: 'a', weight: 1, stance: 0, conviction: 0 }];
    scaleWeights(votes, { a: 0.5 });
    expect(votes[0].weight).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consensus/reliability.test.js`
Expected: FAIL — `Cannot find module '../../src/consensus/reliability.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// src/consensus/reliability.js
export const MIN_RESOLVED = 5;
export const WINDOW = 50;
const RHO_FLOOR = 0.5;
const RHO_CAP = 1.5;
const RANDOM_BRIER = 0.25;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function forecastProb(stance, conviction) {
  return clamp(0.5 + (stance * conviction) / 4, 0, 1);
}

export function brier(prob, outcome) {
  const d = prob - outcome;
  return d * d;
}

export function reliabilityFromBrier(meanBrier, sampleSize) {
  if (sampleSize < MIN_RESOLVED) return 1.0;
  return clamp(1 + 2 * (RANDOM_BRIER - meanBrier), RHO_FLOOR, RHO_CAP);
}

export function scaleWeights(votes, rhoMap = {}) {
  return votes.map((v) => ({
    ...v,
    weight: v.weight * (rhoMap[v.agentId] ?? 1.0),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consensus/reliability.test.js`
Expected: PASS (14 assertions)

- [ ] **Step 5: Commit**

```bash
git add src/consensus/reliability.js test/consensus/reliability.test.js
git commit -m "feat(legion): add Brier reliability math and weight scaling"
```

---

### Task 2: Phase 4 schema migration

**Files:**
- Create: `migrations/phase4_reliability.sql`
- Test: `test/migrations/phase4_reliability.test.js`

The migration is plain SQL applied by the existing migration runner. The test asserts the file exists and contains the required DDL (string assertions — infra-free, mirroring how earlier phases verified schema text).

- [ ] **Step 1: Write the failing test**

```js
// test/migrations/phase4_reliability.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sql = readFileSync(
  fileURLToPath(new URL('../../migrations/phase4_reliability.sql', import.meta.url)),
  'utf8',
).toLowerCase();

describe('phase4 migration DDL', () => {
  it('creates agent_reliability with rho and sample_size', () => {
    expect(sql).toContain('create table if not exists legion.agent_reliability');
    expect(sql).toContain('rho');
    expect(sql).toContain('sample_size');
  });
  it('creates signal_votes snapshot table', () => {
    expect(sql).toContain('create table if not exists legion.signal_votes');
    expect(sql).toContain('signal_id');
    expect(sql).toContain('agent_id');
  });
  it('creates backtest_results', () => {
    expect(sql).toContain('create table if not exists legion.backtest_results');
    expect(sql).toContain('hit_rate');
    expect(sql).toContain('pnl');
  });
  it('adds resolution columns to signals', () => {
    expect(sql).toContain('alter table legion.signals');
    expect(sql).toContain('resolved');
    expect(sql).toContain('forward_return');
    expect(sql).toContain('resolve_after');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/migrations/phase4_reliability.test.js`
Expected: FAIL — `ENOENT ... migrations/phase4_reliability.sql`

- [ ] **Step 3: Write the migration**

```sql
-- migrations/phase4_reliability.sql
-- Phase 4: reliability + backtest schema

CREATE TABLE IF NOT EXISTS legion.agent_reliability (
  agent_id     TEXT PRIMARY KEY,
  rho          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Denormalized per-agent forecast snapshot taken when a signal is emitted.
CREATE TABLE IF NOT EXISTS legion.signal_votes (
  signal_id    BIGINT NOT NULL REFERENCES legion.signals(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  stance       INTEGER NOT NULL,
  conviction   DOUBLE PRECISION NOT NULL,
  weight       DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (signal_id, agent_id)
);

CREATE TABLE IF NOT EXISTS legion.backtest_results (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'deterministic-quant',
  horizon     INTEGER NOT NULL,
  trades      INTEGER NOT NULL,
  hits        INTEGER NOT NULL,
  hit_rate    DOUBLE PRECISION NOT NULL,
  pnl         DOUBLE PRECISION NOT NULL,
  spy_pnl     DOUBLE PRECISION NOT NULL,
  qqq_pnl     DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS entry_price    DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS horizon_days   INTEGER NOT NULL DEFAULT 5;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS resolve_after  TIMESTAMPTZ;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS resolved       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS forward_return DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS spy_return     DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS qqq_return     DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS outcome        INTEGER;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS correct        BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_signals_unresolved
  ON legion.signals (resolve_after) WHERE resolved = false;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrations/phase4_reliability.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Apply migration against the dev DB**

Run: `node src/db/migrate.js` (existing runner picks up the new file)
Expected: applies without error; re-running is a no-op (all statements are idempotent).

- [ ] **Step 6: Commit**

```bash
git add migrations/phase4_reliability.sql test/migrations/phase4_reliability.test.js
git commit -m "feat(legion): add reliability and backtest schema migration"
```

---

### Task 3: GunVest client — historical candles

**Files:**
- Modify: `src/clients/gunvest.js`
- Test: `test/clients/gunvest-candles.test.js`

`getCandles(symbol, days)` returns ascending `[{ date: 'YYYY-MM-DD', close: number }]`. Used by the resolver (forward/benchmark returns) and the deterministic backtest. Mirrors the existing client's fetch-and-map style.

- [ ] **Step 1: Write the failing test**

```js
// test/clients/gunvest-candles.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGunvestClient } from '../../src/clients/gunvest.js';

afterEach(() => vi.restoreAllMocks());

describe('getCandles', () => {
  it('requests the history endpoint and maps date/close ascending', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candles: [
          { date: '2026-05-01', close: 100 },
          { date: '2026-05-02', close: 102 },
        ],
      }),
    });
    const client = createGunvestClient({ baseUrl: 'http://x', fetch: fetchMock });
    const out = await client.getCandles('NVDA', 30);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://x/api/market/NVDA/candles?days=30',
      expect.any(Object),
    );
    expect(out).toEqual([
      { date: '2026-05-01', close: 100 },
      { date: '2026-05-02', close: 102 },
    ]);
  });

  it('throws on non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const client = createGunvestClient({ baseUrl: 'http://x', fetch: fetchMock });
    await expect(client.getCandles('NVDA', 30)).rejects.toThrow(/503/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/clients/gunvest-candles.test.js`
Expected: FAIL — `client.getCandles is not a function`

- [ ] **Step 3: Add the method**

Add inside the object returned by `createGunvestClient` in `src/clients/gunvest.js` (reuse the existing private `get`/fetch helper if present; the code below shows a self-contained version):

```js
  async getCandles(symbol, days) {
    const url = `${baseUrl}/api/market/${symbol}/candles?days=${days}`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GunVest getCandles ${symbol} failed: ${res.status}`);
    const body = await res.json();
    return (body.candles ?? []).map((c) => ({ date: c.date, close: c.close }));
  },
```

If the module already destructures `fetch` as `fetchImpl` and `baseUrl` from options, reuse those names; otherwise add `const fetchImpl = options.fetch ?? globalThis.fetch;` and `const baseUrl = options.baseUrl;` at the top of the factory, matching the existing pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/clients/gunvest-candles.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/clients/gunvest.js test/clients/gunvest-candles.test.js
git commit -m "feat(legion): add getCandles to GunVest client"
```

---

### Task 4: Repo — reliability / resolution / backtest methods

**Files:**
- Modify: `src/db/repo.js`
- Test: `test/db/repo-phase4.test.js`

Tests use a **fake pool** (captures `query` calls, returns canned `{ rows }`) — the infra-free pattern from Phase 3. We assert the SQL substring and the mapped return value. `addSignal` is extended to persist `entry_price`, `horizon_days`, `resolve_after` and to RETURN the new id; a new `addSignalVotes` bulk-inserts the per-agent snapshot.

- [ ] **Step 1: Write the failing test**

```js
// test/db/repo-phase4.test.js
import { describe, it, expect } from 'vitest';
import { createRepo } from '../../src/db/repo.js';

function fakePool(rowsByCall) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const rows = Array.isArray(rowsByCall) ? rowsByCall[i++] ?? [] : rowsByCall;
      return { rows, rowCount: rows.length };
    },
  };
}

describe('repo phase4', () => {
  it('getAllReliability returns an agentId->rho map', async () => {
    const pool = fakePool([
      [{ agent_id: 'technical', rho: 1.3 }, { agent_id: 'news', rho: 0.9 }],
    ]);
    const repo = createRepo(pool);
    const map = await repo.getAllReliability();
    expect(map).toEqual({ technical: 1.3, news: 0.9 });
    expect(pool.calls[0].text.toLowerCase()).toContain('from legion.agent_reliability');
  });

  it('upsertReliability upserts rho + sample_size', async () => {
    const pool = fakePool([[]]);
    const repo = createRepo(pool);
    await repo.upsertReliability('technical', 1.25, 12);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.agent_reliability');
    expect(text.toLowerCase()).toContain('on conflict');
    expect(params).toEqual(['technical', 1.25, 12]);
  });

  it('addSignal persists entry/horizon/resolve_after and returns id', async () => {
    const pool = fakePool([[{ id: 77 }]]);
    const repo = createRepo(pool);
    const id = await repo.addSignal({
      cycleId: 5, symbol: 'NVDA', stance: 1, conviction: 0.7,
      plan: { foo: 1 }, entryPrice: 100, horizonDays: 5,
      resolveAfter: '2026-06-09T00:00:00Z',
    });
    expect(id).toBe(77);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.signals');
    expect(text.toLowerCase()).toContain('returning id');
    expect(params).toContain(100);
    expect(params).toContain('2026-06-09T00:00:00Z');
  });

  it('addSignalVotes bulk-inserts a snapshot row per vote', async () => {
    const pool = fakePool([[]]);
    const repo = createRepo(pool);
    await repo.addSignalVotes(77, [
      { agentId: 'technical', stance: 1, conviction: 0.8, weight: 1.0 },
      { agentId: 'news', stance: -1, conviction: 0.5, weight: 1.2 },
    ]);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.signal_votes');
    // 2 rows * 5 cols
    expect(params).toHaveLength(10);
    expect(params.slice(0, 5)).toEqual([77, 'technical', 1, 0.8, 1.0]);
  });

  it('addSignalVotes is a no-op on empty votes', async () => {
    const pool = fakePool([[]]);
    const repo = createRepo(pool);
    await repo.addSignalVotes(77, []);
    expect(pool.calls).toHaveLength(0);
  });

  it('listUnresolvedSignals filters by resolve_after <= now', async () => {
    const pool = fakePool([[{ id: 1, symbol: 'NVDA', created_at: 'T0', entry_price: 100 }]]);
    const repo = createRepo(pool);
    const out = await repo.listUnresolvedSignals('2026-06-10T00:00:00Z');
    expect(out).toHaveLength(1);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('resolved = false');
    expect(text.toLowerCase()).toContain('resolve_after <=');
    expect(params).toEqual(['2026-06-10T00:00:00Z']);
  });

  it('resolveSignal writes returns + outcome and flips resolved', async () => {
    const pool = fakePool([[]]);
    const repo = createRepo(pool);
    await repo.resolveSignal(1, {
      forwardReturn: 0.05, spyReturn: 0.02, qqqReturn: 0.03, outcome: 1, correct: true,
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('update legion.signals');
    expect(text.toLowerCase()).toContain('resolved = true');
    expect(params).toEqual([0.05, 0.02, 0.03, 1, true, 1]);
  });

  it('getResolvedForecasts joins signal_votes to resolved signals', async () => {
    const pool = fakePool([[
      { agent_id: 'technical', stance: 1, conviction: 0.8, outcome: 1 },
      { agent_id: 'technical', stance: -1, conviction: 0.5, outcome: 0 },
    ]]);
    const repo = createRepo(pool);
    const rows = await repo.getResolvedForecasts(50);
    expect(rows).toHaveLength(2);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('from legion.signal_votes');
    expect(text.toLowerCase()).toContain('join legion.signals');
    expect(text.toLowerCase()).toContain('s.resolved = true');
    expect(params).toEqual([50]);
  });

  it('recordBacktestResult inserts a row', async () => {
    const pool = fakePool([[]]);
    const repo = createRepo(pool);
    await repo.recordBacktestResult({
      symbol: 'NVDA', horizon: 5, trades: 10, hits: 6,
      hitRate: 0.6, pnl: 0.12, spyPnl: 0.05, qqqPnl: 0.07,
    });
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('insert into legion.backtest_results');
    expect(params).toEqual(['NVDA', 5, 10, 6, 0.6, 0.12, 0.05, 0.07]);
  });

  it('getReliabilityLeaderboard orders by rho desc', async () => {
    const pool = fakePool([[{ agent_id: 'technical', rho: 1.4, sample_size: 20 }]]);
    const repo = createRepo(pool);
    const out = await repo.getReliabilityLeaderboard();
    expect(out).toEqual([{ agentId: 'technical', rho: 1.4, sampleSize: 20 }]);
    expect(pool.calls[0].text.toLowerCase()).toContain('order by rho desc');
  });

  it('listBacktestResults filters by symbol when given', async () => {
    const pool = fakePool([[{ id: 1, symbol: 'NVDA', hit_rate: 0.6 }]]);
    const repo = createRepo(pool);
    await repo.listBacktestResults('NVDA', 20);
    const { text, params } = pool.calls[0];
    expect(text.toLowerCase()).toContain('where symbol =');
    expect(params).toEqual(['NVDA', 20]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo-phase4.test.js`
Expected: FAIL — `repo.getAllReliability is not a function`

- [ ] **Step 3: Add the methods**

In `src/db/repo.js`, **replace** the existing `addSignal` with the extended version and add the new methods to the returned object:

```js
  async addSignal({ cycleId, symbol, stance, conviction, plan, entryPrice = null, horizonDays = 5, resolveAfter = null }) {
    const { rows } = await pool.query(
      `INSERT INTO legion.signals
         (cycle_id, symbol, stance, conviction, plan, entry_price, horizon_days, resolve_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [cycleId, symbol, stance, conviction, plan, entryPrice, horizonDays, resolveAfter],
    );
    return rows[0].id;
  },

  async addSignalVotes(signalId, votes) {
    if (!votes.length) return;
    const cols = [];
    const params = [];
    votes.forEach((v, i) => {
      const b = i * 5;
      cols.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
      params.push(signalId, v.agentId, v.stance, v.conviction, v.weight);
    });
    await pool.query(
      `INSERT INTO legion.signal_votes (signal_id, agent_id, stance, conviction, weight)
       VALUES ${cols.join(',')}`,
      params,
    );
  },

  async getAllReliability() {
    const { rows } = await pool.query(`SELECT agent_id, rho FROM legion.agent_reliability`);
    return Object.fromEntries(rows.map((r) => [r.agent_id, r.rho]));
  },

  async upsertReliability(agentId, rho, sampleSize) {
    await pool.query(
      `INSERT INTO legion.agent_reliability (agent_id, rho, sample_size, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (agent_id) DO UPDATE
         SET rho = EXCLUDED.rho, sample_size = EXCLUDED.sample_size, updated_at = now()`,
      [agentId, rho, sampleSize],
    );
  },

  async getReliabilityLeaderboard() {
    const { rows } = await pool.query(
      `SELECT agent_id, rho, sample_size FROM legion.agent_reliability ORDER BY rho DESC`,
    );
    return rows.map((r) => ({ agentId: r.agent_id, rho: r.rho, sampleSize: r.sample_size }));
  },

  async listUnresolvedSignals(now) {
    const { rows } = await pool.query(
      `SELECT id, symbol, created_at, entry_price
         FROM legion.signals
        WHERE resolved = false AND resolve_after IS NOT NULL AND resolve_after <= $1
        ORDER BY resolve_after ASC`,
      [now],
    );
    return rows;
  },

  async resolveSignal(id, { forwardReturn, spyReturn, qqqReturn, outcome, correct }) {
    await pool.query(
      `UPDATE legion.signals
          SET forward_return = $1, spy_return = $2, qqq_return = $3,
              outcome = $4, correct = $5, resolved = true
        WHERE id = $6`,
      [forwardReturn, spyReturn, qqqReturn, outcome, correct, id],
    );
  },

  async getResolvedForecasts(limit) {
    const { rows } = await pool.query(
      `SELECT sv.agent_id, sv.stance, sv.conviction, s.outcome
         FROM legion.signal_votes sv
         JOIN legion.signals s ON s.id = sv.signal_id
        WHERE s.resolved = true AND s.outcome IS NOT NULL
        ORDER BY s.id DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  },

  async recordBacktestResult({ symbol, horizon, trades, hits, hitRate, pnl, spyPnl, qqqPnl }) {
    await pool.query(
      `INSERT INTO legion.backtest_results
         (symbol, horizon, trades, hits, hit_rate, pnl, spy_pnl, qqq_pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [symbol, horizon, trades, hits, hitRate, pnl, spyPnl, qqqPnl],
    );
  },

  async listBacktestResults(symbol, limit) {
    if (symbol) {
      const { rows } = await pool.query(
        `SELECT * FROM legion.backtest_results WHERE symbol = $1 ORDER BY created_at DESC LIMIT $2`,
        [symbol, limit],
      );
      return rows;
    }
    const { rows } = await pool.query(
      `SELECT * FROM legion.backtest_results ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  },
```

> **Note on `addSignal` callers:** the Phase 2 emitter called `addSignal` and ignored the return. The new version returns the id (needed for `addSignalVotes`). Existing callers keep working; Task 7 updates the emitter to use the id.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/repo-phase4.test.js`
Expected: PASS (11 tests)

- [ ] **Step 5: Run the full repo suite to confirm no regression**

Run: `npx vitest run test/db/`
Expected: PASS — Phase 1-3 repo tests still green (`addSignal` superset is backward compatible for the fields they pass).

- [ ] **Step 6: Commit**

```bash
git add src/db/repo.js test/db/repo-phase4.test.js
git commit -m "feat(legion): add reliability, resolution, and backtest repo methods"
```

---

### Task 5: Signal resolver (forward paper-test)

**Files:**
- Create: `src/reliability/resolver.js`
- Test: `test/reliability/resolver.test.js`

`returnOver(candles, fromTs, toTs)` computes `(c1 - c0) / c0` where `c0` is the first close on/after `fromTs`'s date and `c1` the last close on/before `toTs`'s date (null if not enough data). `resolveSignals(repo, gunvest, now)` resolves every due signal: pulls candles for the symbol + SPY + QQQ, computes returns over the holding window, sets `outcome = forwardReturn > spyReturn ? 1 : 0`, and `correct` (null for HOLD/stance 0, else direction matches excess return sign).

- [ ] **Step 1: Write the failing test**

```js
// test/reliability/resolver.test.js
import { describe, it, expect } from 'vitest';
import { returnOver, resolveSignals } from '../../src/reliability/resolver.js';

const candles = [
  { date: '2026-06-01', close: 100 },
  { date: '2026-06-02', close: 101 },
  { date: '2026-06-06', close: 110 },
];

describe('returnOver', () => {
  it('computes return between first>=from and last<=to', () => {
    expect(returnOver(candles, '2026-06-01', '2026-06-06')).toBeCloseTo(0.10);
  });
  it('returns null when window has <2 usable closes', () => {
    expect(returnOver(candles, '2026-06-10', '2026-06-20')).toBeNull();
  });
});

describe('resolveSignals', () => {
  function gunvestStub(map) {
    return { getCandles: async (sym) => map[sym] };
  }

  it('resolves a bullish signal that beat SPY as correct', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 1, symbol: 'NVDA', created_at: '2026-06-01', entry_price: 100 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      // resolver reads stance from signal_votes? No — uses the signal row direction.
    };
    // Signal direction comes from the persisted signal stance; stub returns it.
    repo.getSignalStance = async () => 1; // bullish
    const gunvest = gunvestStub({
      NVDA: [{ date: '2026-06-01', close: 100 }, { date: '2026-06-08', close: 110 }], // +10%
      SPY: [{ date: '2026-06-01', close: 400 }, { date: '2026-06-08', close: 408 }], // +2%
      QQQ: [{ date: '2026-06-01', close: 300 }, { date: '2026-06-08', close: 309 }], // +3%
    });
    const count = await resolveSignals(repo, gunvest, '2026-06-08');
    expect(count).toBe(1);
    expect(resolved[0].outcome).toBe(1); // beat SPY
    expect(resolved[0].correct).toBe(true); // bullish & positive excess
    expect(resolved[0].forwardReturn).toBeCloseTo(0.10);
  });

  it('marks bullish signal that lagged SPY as incorrect, outcome 0', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 2, symbol: 'MU', created_at: '2026-06-01', entry_price: 50 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 1,
    };
    const gunvest = gunvestStub({
      MU: [{ date: '2026-06-01', close: 50 }, { date: '2026-06-08', close: 50.5 }], // +1%
      SPY: [{ date: '2026-06-01', close: 400 }, { date: '2026-06-08', close: 420 }], // +5%
      QQQ: [{ date: '2026-06-01', close: 300 }, { date: '2026-06-08', close: 315 }],
    });
    await resolveSignals(repo, gunvest, '2026-06-08');
    expect(resolved[0].outcome).toBe(0);
    expect(resolved[0].correct).toBe(false);
  });

  it('leaves correct null for HOLD signals but still records returns', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 3, symbol: 'AMD', created_at: '2026-06-01', entry_price: 80 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 0,
    };
    const gunvest = gunvestStub({
      AMD: [{ date: '2026-06-01', close: 80 }, { date: '2026-06-08', close: 82 }],
      SPY: [{ date: '2026-06-01', close: 400 }, { date: '2026-06-08', close: 404 }],
      QQQ: [{ date: '2026-06-01', close: 300 }, { date: '2026-06-08', close: 303 }],
    });
    await resolveSignals(repo, gunvest, '2026-06-08');
    expect(resolved[0].correct).toBeNull();
    expect(resolved[0].forwardReturn).toBeCloseTo(0.025);
  });

  it('skips a signal when candle data is insufficient', async () => {
    const resolved = [];
    const repo = {
      listUnresolvedSignals: async () => [
        { id: 4, symbol: 'X', created_at: '2026-06-01', entry_price: 10 },
      ],
      resolveSignal: async (id, data) => resolved.push({ id, ...data }),
      getSignalStance: async () => 1,
    };
    const gunvest = gunvestStub({
      X: [{ date: '2026-06-01', close: 10 }], SPY: [], QQQ: [],
    });
    const count = await resolveSignals(repo, gunvest, '2026-06-08');
    expect(count).toBe(0);
    expect(resolved).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reliability/resolver.test.js`
Expected: FAIL — `Cannot find module '../../src/reliability/resolver.js'`

- [ ] **Step 3: Add `getSignalStance` to the repo, then implement the resolver**

First add to `src/db/repo.js` (the resolver needs the persisted direction):

```js
  async getSignalStance(id) {
    const { rows } = await pool.query(`SELECT stance FROM legion.signals WHERE id = $1`, [id]);
    return rows[0]?.stance ?? 0;
  },
```

Then create `src/reliability/resolver.js`:

```js
// src/reliability/resolver.js
const HORIZON_FETCH_DAYS = 90; // enough candle history to span any open holding window

function day(ts) {
  return String(ts).slice(0, 10);
}

export function returnOver(candles, fromTs, toTs) {
  const from = day(fromTs);
  const to = day(toTs);
  const within = candles.filter((c) => c.date >= from && c.date <= to);
  if (within.length < 2) return null;
  const c0 = within[0].close;
  const c1 = within[within.length - 1].close;
  if (!c0) return null;
  return (c1 - c0) / c0;
}

export async function resolveSignals(repo, gunvest, now) {
  const due = await repo.listUnresolvedSignals(now);
  let resolved = 0;
  for (const sig of due) {
    const [stock, spy, qqq] = await Promise.all([
      gunvest.getCandles(sig.symbol, HORIZON_FETCH_DAYS),
      gunvest.getCandles('SPY', HORIZON_FETCH_DAYS),
      gunvest.getCandles('QQQ', HORIZON_FETCH_DAYS),
    ]);
    const forwardReturn = returnOver(stock, sig.created_at, now);
    const spyReturn = returnOver(spy, sig.created_at, now);
    const qqqReturn = returnOver(qqq, sig.created_at, now);
    if (forwardReturn == null || spyReturn == null) continue;

    const outcome = forwardReturn > spyReturn ? 1 : 0;
    const stance = await repo.getSignalStance(sig.id);
    const excess = forwardReturn - spyReturn;
    let correct = null;
    if (stance > 0) correct = excess > 0;
    else if (stance < 0) correct = excess < 0;

    await repo.resolveSignal(sig.id, {
      forwardReturn,
      spyReturn,
      qqqReturn: qqqReturn ?? null,
      outcome,
      correct,
    });
    resolved += 1;
  }
  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reliability/resolver.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/reliability/resolver.js src/db/repo.js test/reliability/resolver.test.js
git commit -m "feat(legion): add forward paper-test signal resolver"
```

---

### Task 6: Reliability recompute (Brier loop)

**Files:**
- Create: `src/reliability/update.js`
- Test: `test/reliability/update.test.js`

`recomputeReliability(repo)` pulls the last `WINDOW` resolved forecasts, groups by agent, computes each agent's mean Brier from `forecastProb(stance, conviction)` vs `outcome`, derives ρ via `reliabilityFromBrier`, and upserts. Returns the `{ agentId: rho }` map it wrote.

- [ ] **Step 1: Write the failing test**

```js
// test/reliability/update.test.js
import { describe, it, expect } from 'vitest';
import { recomputeReliability } from '../../src/reliability/update.js';

describe('recomputeReliability', () => {
  it('rewards an agent whose confident calls resolved correctly', async () => {
    // 6 forecasts, all strong-correct: stance +2 conv 1 -> p=1, outcome 1 -> brier 0
    const forecasts = Array.from({ length: 6 }, () => ({
      agent_id: 'technical', stance: 2, conviction: 1, outcome: 1,
    }));
    const writes = [];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async (id, rho, n) => writes.push({ id, rho, n }),
    };
    const map = await recomputeReliability(repo);
    expect(map.technical).toBeCloseTo(1.5); // perfect -> cap
    expect(writes[0]).toMatchObject({ id: 'technical', n: 6 });
  });

  it('penalizes an agent whose confident calls resolved wrong', async () => {
    const forecasts = Array.from({ length: 6 }, () => ({
      agent_id: 'social', stance: 2, conviction: 1, outcome: 0, // p=1, o=0 -> brier 1
    }));
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.social).toBeCloseTo(0.5); // worst -> floor
  });

  it('keeps neutral 1.0 below MIN_RESOLVED sample', async () => {
    const forecasts = [
      { agent_id: 'news', stance: 2, conviction: 1, outcome: 1 },
      { agent_id: 'news', stance: 2, conviction: 1, outcome: 1 },
    ];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.news).toBe(1.0);
  });

  it('computes per-agent independently in one pass', async () => {
    const mk = (id, outcome) =>
      Array.from({ length: 5 }, () => ({ agent_id: id, stance: 2, conviction: 1, outcome }));
    const repo = {
      getResolvedForecasts: async () => [...mk('a', 1), ...mk('b', 0)],
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.a).toBeCloseTo(1.5);
    expect(map.b).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/reliability/update.test.js`
Expected: FAIL — `Cannot find module '../../src/reliability/update.js'`

- [ ] **Step 3: Implement**

```js
// src/reliability/update.js
import {
  forecastProb,
  brier,
  reliabilityFromBrier,
  WINDOW,
} from '../consensus/reliability.js';

export async function recomputeReliability(repo) {
  const rows = await repo.getResolvedForecasts(WINDOW * 8); // headroom for many agents
  const byAgent = new Map();
  for (const r of rows) {
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    const bucket = byAgent.get(r.agent_id);
    if (bucket.length < WINDOW) {
      bucket.push(brier(forecastProb(r.stance, r.conviction), r.outcome));
    }
  }
  const map = {};
  for (const [agentId, briers] of byAgent) {
    const meanBrier = briers.reduce((a, b) => a + b, 0) / briers.length;
    const rho = reliabilityFromBrier(meanBrier, briers.length);
    map[agentId] = rho;
    await repo.upsertReliability(agentId, rho, briers.length);
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/reliability/update.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/reliability/update.js test/reliability/update.test.js
git commit -m "feat(legion): add Brier reliability recompute loop"
```

---

### Task 7: Emitter — apply ρ at aggregation, persist forecast snapshot + entry/horizon

**Files:**
- Modify: `src/emit/emitter.js`
- Test: `test/emit/emitter-reliability.test.js`

This **extends** the Phase 2 emitter (does not replace its tests). Two changes:
1. Before each `evaluateRound` / `buildSignal`, load reliability once per cycle and `scaleWeights(votes, rhoMap)` so effective weight = `w_i · ρ_i`.
2. On finalize, capture the entry price (latest close from the final votes' price context, falling back to `gunvest.getPrice`), compute `resolveAfter = now + horizonDays`, pass them to `addSignal`, then `addSignalVotes(signalId, finalVotes)`.

The emitter already receives `{ bus, repo, telegram, consensus, expectedAgents, riskEnabled, logger }`. Add `gunvest`, `horizonDays`, and `clock` (defaults `() => new Date()`), all optional with safe defaults so Phase 2 tests still construct it.

- [ ] **Step 1: Write the failing test**

```js
// test/emit/emitter-reliability.test.js
import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';
import { createEmitter } from '../../src/emit/emitter.js';
import { cycleSubject, voteSubject, consensusSubject } from '../../src/bus/subjects.js';

function buildRepo() {
  const calls = { signals: [], signalVotes: [] };
  return {
    calls,
    createCycle: async () => 1,
    addRound: async () => 1,
    addVote: async () => {},
    addSignal: async (s) => { calls.signals.push(s); return 99; },
    addSignalVotes: async (id, votes) => calls.signalVotes.push({ id, votes }),
    finishCycle: async () => {},
    getAllReliability: async () => ({ technical: 1.5, news: 0.5 }),
  };
}

const votesFor = (cycleId, round) => ([
  { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1.0, rationale: 't' },
  { agentId: 'news', stance: 2, conviction: 0.9, weight: 1.2, rationale: 'n' },
  { agentId: 'social', stance: 2, conviction: 0.8, weight: 0.8, rationale: 's' },
  { agentId: 'contrarian', stance: 1, conviction: 0.6, weight: 0.9, rationale: 'c' },
].map((v) => ({ cycleId, symbol: 'NVDA', round, vote: v })));

describe('emitter reliability', () => {
  it('scales vote weights by rho before persisting the forecast snapshot', async () => {
    const bus = createMemoryBus();
    const repo = buildRepo();
    const gunvest = { getPrice: async () => ({ price: 120 }) };
    const emitter = createEmitter({
      bus, repo,
      telegram: { send: async () => {} },
      consensus: { maxRounds: 3, thetaV: 0.5, quorum: 2 / 3, holdBand: 0.5 },
      expectedAgents: 4,
      riskEnabled: false,
      gunvest,
      horizonDays: 5,
      clock: () => new Date('2026-06-04T00:00:00Z'),
      logger: { info() {}, error() {} },
    });
    await emitter.start();

    for (const m of votesFor(1, 1)) {
      await bus.publish(voteSubject('NVDA', 1), m);
    }
    await vi.waitFor(() => expect(repo.calls.signals).toHaveLength(1));

    // entry price + resolve window persisted
    const sig = repo.calls.signals[0];
    expect(sig.entryPrice).toBe(120);
    expect(sig.horizonDays).toBe(5);
    expect(new Date(sig.resolveAfter).toISOString()).toBe('2026-06-09T00:00:00.000Z');

    // forecast snapshot persisted with scaled weights
    const snap = repo.calls.signalVotes[0];
    expect(snap.id).toBe(99);
    const tech = snap.votes.find((v) => v.agentId === 'technical');
    const news = snap.votes.find((v) => v.agentId === 'news');
    expect(tech.weight).toBeCloseTo(1.5); // 1.0 * 1.5
    expect(news.weight).toBeCloseTo(0.6); // 1.2 * 0.5
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/emit/emitter-reliability.test.js`
Expected: FAIL — `repo.calls.signalVotes` empty / `entryPrice` undefined (emitter doesn't scale or snapshot yet).

- [ ] **Step 3: Modify the emitter**

In `src/emit/emitter.js`:

a) Import the helper at the top:

```js
import { scaleWeights } from '../consensus/reliability.js';
```

b) Update the factory signature defaults:

```js
export function createEmitter({
  bus, repo, telegram, consensus,
  expectedAgents = 4,
  riskEnabled = false,
  gunvest = null,
  horizonDays = 5,
  clock = () => new Date(),
  logger = console,
}) {
```

c) In the finalize path, where the Phase 2 emitter currently builds the signal from `votes`, scale first and snapshot after persisting. Replace the finalize block with:

```js
    // --- finalize: aggregate with reliability-scaled weights ---
    const rhoMap = await repo.getAllReliability();
    const scaled = scaleWeights(votes, rhoMap);

    const evalResult = evaluateRound(scaled, {
      thetaV: consensus.thetaV,
      quorum: consensus.quorum,
      holdBand: consensus.holdBand,
    });

    let signal = buildSignal({ symbol, votes: scaled, evalResult });
    if (riskEnabled && constraint) {
      signal = applyRiskConstraint(signal, constraint);
    }

    const now = clock();
    const resolveAfter = new Date(now.getTime() + horizonDays * 86400000).toISOString();
    let entryPrice = null;
    if (gunvest) {
      try {
        const p = await gunvest.getPrice(symbol);
        entryPrice = p?.price ?? null;
      } catch (err) {
        logger.error?.(`emitter: entry price fetch failed for ${symbol}: ${err.message}`);
      }
    }

    const signalId = await repo.addSignal({
      cycleId,
      symbol,
      stance: signal.stance,
      conviction: signal.conviction,
      plan: signal.plan,
      entryPrice,
      horizonDays,
      resolveAfter,
    });
    await repo.addSignalVotes(signalId, scaled.map((v) => ({
      agentId: v.agentId,
      stance: v.stance,
      conviction: v.conviction,
      weight: v.weight,
    })));

    await repo.finishCycle(cycleId, evalResult.converged ? 'converged' : 'no_consensus');
    await telegram.send(formatSignal(signal));
    await bus.publish(consensusSubject(symbol), { cycleId, symbol, signal });
```

> Keep the existing non-final path (republish `cycleSubject` round+1 with `priorVotes`) unchanged. `evaluateRound` for the **convergence check on intermediate rounds** should also use `scaled` weights — apply the same `scaleWeights(votes, rhoMap)` at the top of the ready-handler so every round aggregates consistently. Load `rhoMap` once per cycle and cache it in the pending entry to avoid re-querying each round.

d) Cache rhoMap per cycle: when a pending entry is first created, set `pending.rhoMap = await repo.getAllReliability()` and reuse `pending.rhoMap` in both the intermediate convergence check and the finalize block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/emit/emitter-reliability.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full emitter suite to confirm Phase 2 still passes**

Run: `npx vitest run test/emit/`
Expected: PASS — Phase 2 emitter tests green. (Phase 2 tests construct the emitter without `gunvest`; `entryPrice` stays null, `addSignalVotes` still called with whatever votes — if a Phase 2 repo double lacks `addSignalVotes`/`getAllReliability`, add no-op stubs to those doubles in the Phase 2 test file as a one-line update and note it in the commit body.)

- [ ] **Step 6: Commit**

```bash
git add src/emit/emitter.js test/emit/emitter-reliability.test.js
git commit -m "feat(legion): scale consensus weights by reliability and snapshot forecasts"
```

---

### Task 8: Deterministic indicators + quant stance (pure)

**Files:**
- Create: `src/backtest/indicators.js`
- Test: `test/backtest/indicators.test.js`

Pure, LLM-free technical core for the deterministic backtest. `computeIndicators(closes)` returns `{ sma20, sma50, rsi, macd, signal }` for the **last** bar (null fields when insufficient history). `quantStance(ind)` maps trend (sma20 vs sma50), momentum (macd vs signal), and RSI extremes to an ordinal stance in `[-2, 2]`.

- [ ] **Step 1: Write the failing test**

```js
// test/backtest/indicators.test.js
import { describe, it, expect } from 'vitest';
import { sma, rsi, macd, computeIndicators, quantStance } from '../../src/backtest/indicators.js';

const up = Array.from({ length: 60 }, (_, i) => 100 + i); // strictly rising
const down = Array.from({ length: 60 }, (_, i) => 160 - i); // strictly falling

describe('sma', () => {
  it('averages the last N', () => {
    expect(sma([1, 2, 3, 4], 2)).toBeCloseTo(3.5);
  });
  it('returns null when too short', () => {
    expect(sma([1], 2)).toBeNull();
  });
});

describe('rsi', () => {
  it('is ~100 for a strictly rising series', () => {
    expect(rsi(up, 14)).toBeGreaterThan(95);
  });
  it('is ~0 for a strictly falling series', () => {
    expect(rsi(down, 14)).toBeLessThan(5);
  });
});

describe('macd', () => {
  it('is positive when fast EMA leads on an uptrend', () => {
    const { macd: line, signal } = macd(up);
    expect(line).toBeGreaterThan(signal);
  });
});

describe('quantStance', () => {
  it('strong buy when trend up + momentum up', () => {
    expect(quantStance({ sma20: 120, sma50: 110, macd: 2, signal: 1, rsi: 55 })).toBe(2);
  });
  it('strong sell when trend down + momentum down', () => {
    expect(quantStance({ sma20: 100, sma50: 110, macd: -2, signal: -1, rsi: 45 })).toBe(-2);
  });
  it('HOLD on mixed signals', () => {
    expect(quantStance({ sma20: 110, sma50: 110, macd: 1, signal: 1, rsi: 50 })).toBe(0);
  });
  it('returns HOLD when indicators are null (insufficient data)', () => {
    expect(quantStance({ sma20: null, sma50: null, macd: null, signal: null, rsi: null })).toBe(0);
  });
});

describe('computeIndicators', () => {
  it('produces non-null indicators given enough history', () => {
    const ind = computeIndicators(up);
    expect(ind.sma20).not.toBeNull();
    expect(ind.sma50).not.toBeNull();
    expect(ind.rsi).not.toBeNull();
  });
  it('nulls long-window indicators when history is short', () => {
    const ind = computeIndicators([100, 101, 102]);
    expect(ind.sma50).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/backtest/indicators.test.js`
Expected: FAIL — `Cannot find module '../../src/backtest/indicators.js'`

- [ ] **Step 3: Implement**

```js
// src/backtest/indicators.js
export const RSI_OVERSOLD = 30;
export const RSI_OVERBOUGHT = 70;

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // seed with SMA of the first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  if (emaFast == null || emaSlow == null) return { macd: null, signal: null };
  const line = emaFast - emaSlow;
  // signal = EMA of the macd line; approximate using a short tail of macd lines
  const lines = [];
  for (let i = slow; i <= values.length; i += 1) {
    const sub = values.slice(0, i);
    const f = ema(sub, fast);
    const s = ema(sub, slow);
    if (f != null && s != null) lines.push(f - s);
  }
  const signal = ema(lines, signalPeriod) ?? line;
  return { macd: line, signal };
}

export function computeIndicators(closes) {
  const { macd: macdLine, signal } = macd(closes);
  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi: rsi(closes, 14),
    macd: macdLine,
    signal,
  };
}

export function quantStance(ind) {
  if (ind.sma20 == null || ind.sma50 == null || ind.macd == null || ind.rsi == null) {
    return 0;
  }
  let score = 0;
  score += ind.sma20 > ind.sma50 ? 1 : ind.sma20 < ind.sma50 ? -1 : 0;
  score += ind.macd > ind.signal ? 1 : ind.macd < ind.signal ? -1 : 0;
  if (ind.rsi < RSI_OVERSOLD) score += 1;
  if (ind.rsi > RSI_OVERBOUGHT) score -= 1;
  return Math.max(-2, Math.min(2, score));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/backtest/indicators.test.js`
Expected: PASS (12 assertions)

- [ ] **Step 5: Commit**

```bash
git add src/backtest/indicators.js test/backtest/indicators.test.js
git commit -m "feat(legion): add deterministic technical indicators and quant stance"
```

---

### Task 9: Deterministic backtest engine (pure)

**Files:**
- Create: `src/backtest/deterministic.js`
- Test: `test/backtest/deterministic.test.js`

`runBacktest(candles, spy, qqq, { horizon })` walks the stock candles. At each bar `i` (once enough history exists), it computes `quantStance` from `candles[0..i]`. On a non-HOLD stance it opens a trade: exit at bar `i + horizon`, trade return = `direction * (exitClose - entryClose) / entryClose` (direction = sign(stance)). It accumulates `trades`, `hits` (trade return > 0), `pnl` (sum of trade returns), and benchmark P&L over the same entry/exit dates from `spy`/`qqq`. Returns `{ trades, hits, hitRate, pnl, spyPnl, qqqPnl }`.

- [ ] **Step 1: Write the failing test**

```js
// test/backtest/deterministic.test.js
import { describe, it, expect } from 'vitest';
import { runBacktest } from '../../src/backtest/deterministic.js';

function series(prices, startDay = 1) {
  return prices.map((p, i) => ({
    date: `2026-06-${String(startDay + i).padStart(2, '0')}`,
    close: p,
  }));
}

describe('runBacktest', () => {
  it('returns zeroed result when history is too short to ever signal', () => {
    const candles = series([100, 101, 102]);
    const r = runBacktest(candles, candles, candles, { horizon: 2 });
    expect(r.trades).toBe(0);
    expect(r.hitRate).toBe(0);
    expect(r.pnl).toBe(0);
  });

  it('long trade on an uptrend is a profitable hit', () => {
    // 60 strictly-rising bars -> quantStance bullish; horizon exits higher
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = prices.map((p, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: p }));
    const flatBench = candles.map((c) => ({ date: c.date, close: 400 }));
    const r = runBacktest(candles, flatBench, flatBench, { horizon: 3 });
    expect(r.trades).toBeGreaterThan(0);
    expect(r.hits).toBe(r.trades); // every long on a monotonic uptrend wins
    expect(r.hitRate).toBeCloseTo(1.0);
    expect(r.pnl).toBeGreaterThan(0);
    expect(r.spyPnl).toBeCloseTo(0); // flat benchmark
  });

  it('hitRate is hits/trades', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
    const candles = prices.map((p, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: p }));
    const r = runBacktest(candles, candles, candles, { horizon: 3 });
    if (r.trades > 0) expect(r.hitRate).toBeCloseTo(r.hits / r.trades);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/backtest/deterministic.test.js`
Expected: FAIL — `Cannot find module '../../src/backtest/deterministic.js'`

- [ ] **Step 3: Implement**

```js
// src/backtest/deterministic.js
import { computeIndicators, quantStance } from './indicators.js';

const MIN_HISTORY = 50; // need sma50 before trading

function benchReturn(bench, fromDate, toDate) {
  const a = bench.find((c) => c.date === fromDate);
  const b = bench.find((c) => c.date === toDate);
  if (!a || !b || !a.close) return 0;
  return (b.close - a.close) / a.close;
}

export function runBacktest(candles, spy, qqq, { horizon }) {
  const closes = candles.map((c) => c.close);
  let trades = 0;
  let hits = 0;
  let pnl = 0;
  let spyPnl = 0;
  let qqqPnl = 0;

  for (let i = MIN_HISTORY; i + horizon < candles.length; i += 1) {
    const ind = computeIndicators(closes.slice(0, i + 1));
    const stance = quantStance(ind);
    if (stance === 0) continue;

    const dir = Math.sign(stance);
    const entry = candles[i];
    const exit = candles[i + horizon];
    if (!entry.close) continue;

    const tradeReturn = (dir * (exit.close - entry.close)) / entry.close;
    trades += 1;
    if (tradeReturn > 0) hits += 1;
    pnl += tradeReturn;
    spyPnl += dir * benchReturn(spy, entry.date, exit.date);
    qqqPnl += dir * benchReturn(qqq, entry.date, exit.date);
  }

  return {
    trades,
    hits,
    hitRate: trades ? hits / trades : 0,
    pnl,
    spyPnl,
    qqqPnl,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/backtest/deterministic.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/backtest/deterministic.js test/backtest/deterministic.test.js
git commit -m "feat(legion): add deterministic backtest engine"
```

---

### Task 10: API routes — reliability leaderboard + backtest results

**Files:**
- Create: `src/api/routes/reliability.js`
- Create: `src/api/routes/backtest.js`
- Modify: `src/api/app.js` (mount the two routers)
- Test: `test/api/reliability-backtest.test.js`

Read-only JSON, supertest against `createApp({ repo })` (Phase 3 pattern). `GET /api/reliability` → leaderboard; `GET /api/backtest?symbol=NVDA` → results (symbol optional, capped at 50).

- [ ] **Step 1: Write the failing test**

```js
// test/api/reliability-backtest.test.js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub() {
  return {
    getReliabilityLeaderboard: async () => [
      { agentId: 'technical', rho: 1.4, sampleSize: 20 },
      { agentId: 'news', rho: 0.8, sampleSize: 15 },
    ],
    listBacktestResults: async (symbol, limit) => [
      { id: 1, symbol: symbol ?? 'NVDA', hit_rate: 0.6, pnl: 0.12, _limit: limit },
    ],
  };
}

describe('GET /api/reliability', () => {
  it('returns the leaderboard', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/reliability');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].agentId).toBe('technical');
  });
});

describe('GET /api/backtest', () => {
  it('returns all results when no symbol given', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/backtest');
    expect(res.status).toBe(200);
    expect(res.body[0]._limit).toBe(50);
  });
  it('passes the symbol filter through', async () => {
    const res = await request(createApp({ repo: repoStub() })).get('/api/backtest?symbol=MU');
    expect(res.status).toBe(200);
    expect(res.body[0].symbol).toBe('MU');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/reliability-backtest.test.js`
Expected: FAIL — 404 (routes not mounted).

- [ ] **Step 3: Create routers and mount them**

```js
// src/api/routes/reliability.js
import { Router } from 'express';

export function reliabilityRouter(repo) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      res.json(await repo.getReliabilityLeaderboard());
    } catch (err) {
      next(err);
    }
  });
  return router;
}
```

```js
// src/api/routes/backtest.js
import { Router } from 'express';

const LIMIT = 50;

export function backtestRouter(repo) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      const symbol = req.query.symbol || null;
      res.json(await repo.listBacktestResults(symbol, LIMIT));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
```

In `src/api/app.js`, import and mount alongside the Phase 3 routers:

```js
import { reliabilityRouter } from './routes/reliability.js';
import { backtestRouter } from './routes/backtest.js';
// ... inside createApp, after existing app.use('/api/...') mounts:
  app.use('/api/reliability', reliabilityRouter(repo));
  app.use('/api/backtest', backtestRouter(repo));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api/reliability-backtest.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Run full API suite**

Run: `npx vitest run test/api/`
Expected: PASS — Phase 3 routes unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/reliability.js src/api/routes/backtest.js src/api/app.js test/api/reliability-backtest.test.js
git commit -m "feat(legion): add reliability and backtest API routes"
```

---

### Task 11: Entrypoints — reliability cron + backtest CLI, config, compose

**Files:**
- Modify: `config/index.js` (add `reliabilityCron`, `horizonDays`)
- Create: `src/run/reliability.js`
- Create: `src/run/backtest.js`
- Modify: `docker-compose.yml` (add `reliability` service)
- Test: `test/run/reliability-runner.test.js`

`src/run/reliability.js` exports `runReliabilityOnce({ repo, gunvest, clock })` — resolve due signals, then recompute ρ — and, when run as a script, schedules it on `reliabilityCron` (default `0 */12 * * *`) with a `--now` flag. `src/run/backtest.js` exports `runBacktestOnce({ repo, gunvest, horizonDays })` — for each enabled ticker, fetch candles + SPY/QQQ, `runBacktest`, `recordBacktestResult`.

Only the pure orchestration (`runReliabilityOnce`, `runBacktestOnce`) is unit-tested; cron wiring follows the Phase 2 scheduler pattern and is verified manually.

- [ ] **Step 1: Write the failing test**

```js
// test/run/reliability-runner.test.js
import { describe, it, expect, vi } from 'vitest';
import { runReliabilityOnce } from '../../src/run/reliability.js';
import { runBacktestOnce } from '../../src/run/backtest.js';

describe('runReliabilityOnce', () => {
  it('resolves due signals then recomputes reliability, returning a summary', async () => {
    const order = [];
    const repo = {
      listUnresolvedSignals: async () => { order.push('list'); return []; },
      resolveSignal: async () => {},
      getSignalStance: async () => 0,
      getResolvedForecasts: async () => { order.push('forecasts'); return []; },
      upsertReliability: async () => {},
    };
    const gunvest = { getCandles: async () => [] };
    const out = await runReliabilityOnce({ repo, gunvest, clock: () => new Date('2026-06-10') });
    expect(order).toEqual(['list', 'forecasts']);
    expect(out).toMatchObject({ resolved: 0 });
    expect(out.reliability).toEqual({});
  });
});

describe('runBacktestOnce', () => {
  it('runs the deterministic backtest per enabled ticker and records results', async () => {
    const recorded = [];
    const repo = {
      listEnabledTickers: async () => ['NVDA'],
      recordBacktestResult: async (r) => recorded.push(r),
    };
    const candle = (n) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, close: 100 + i }));
    const gunvest = { getCandles: async () => candle(60) };
    const out = await runBacktestOnce({ repo, gunvest, horizonDays: 3 });
    expect(out.tickers).toBe(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].symbol).toBe('NVDA');
    expect(recorded[0].horizon).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run/reliability-runner.test.js`
Expected: FAIL — `Cannot find module '../../src/run/reliability.js'`

- [ ] **Step 3: Add config, then implement both runners**

In `config/index.js` add to the exported config object:

```js
  reliabilityCron: process.env.LEGION_RELIABILITY_CRON ?? '0 */12 * * *',
  horizonDays: Number(process.env.LEGION_HORIZON_DAYS ?? 5),
```

```js
// src/run/reliability.js
import cron from 'node-cron';
import { resolveSignals } from '../reliability/resolver.js';
import { recomputeReliability } from '../reliability/update.js';

export async function runReliabilityOnce({ repo, gunvest, clock = () => new Date() }) {
  const now = clock().toISOString();
  const resolved = await resolveSignals(repo, gunvest, now);
  const reliability = await recomputeReliability(repo);
  return { resolved, reliability };
}

async function main() {
  const { createPool } = await import('../db/pool.js');
  const { createRepo } = await import('../db/repo.js');
  const { createGunvestClient } = await import('../clients/gunvest.js');
  const { config } = await import('../../config/index.js');

  const repo = createRepo(createPool());
  const gunvest = createGunvestClient({ baseUrl: config.gunvestBaseUrl });
  const runner = () =>
    runReliabilityOnce({ repo, gunvest })
      .then((s) => console.info(`reliability: resolved=${s.resolved}`, s.reliability))
      .catch((err) => console.error('reliability run failed:', err.message));

  if (process.argv.includes('--now')) {
    await runner();
    process.exit(0);
  }
  cron.schedule(config.reliabilityCron, runner);
  console.info(`reliability runner scheduled: ${config.reliabilityCron}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

```js
// src/run/backtest.js
import { runBacktest } from '../backtest/deterministic.js';

const FETCH_DAYS = 400;

export async function runBacktestOnce({ repo, gunvest, horizonDays }) {
  const tickers = await repo.listEnabledTickers();
  const [spy, qqq] = await Promise.all([
    gunvest.getCandles('SPY', FETCH_DAYS),
    gunvest.getCandles('QQQ', FETCH_DAYS),
  ]);
  for (const symbol of tickers) {
    const candles = await gunvest.getCandles(symbol, FETCH_DAYS);
    const r = runBacktest(candles, spy, qqq, { horizon: horizonDays });
    await repo.recordBacktestResult({ symbol, horizon: horizonDays, ...r });
  }
  return { tickers: tickers.length };
}

async function main() {
  const { createPool } = await import('../db/pool.js');
  const { createRepo } = await import('../db/repo.js');
  const { createGunvestClient } = await import('../clients/gunvest.js');
  const { config } = await import('../../config/index.js');

  const repo = createRepo(createPool());
  const gunvest = createGunvestClient({ baseUrl: config.gunvestBaseUrl });
  await runBacktestOnce({ repo, gunvest, horizonDays: config.horizonDays })
    .then((s) => console.info(`backtest complete: ${s.tickers} tickers`))
    .catch((err) => console.error('backtest failed:', err.message));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

> `recordBacktestResult` accepts `{ symbol, horizon, trades, hits, hitRate, pnl, spyPnl, qqqPnl }`; `runBacktest` returns `{ trades, hits, hitRate, pnl, spyPnl, qqqPnl }`, so the spread `...r` lines up exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/run/reliability-runner.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the `reliability` service to `docker-compose.yml`**

```yaml
  reliability:
    build: .
    command: node src/run/reliability.js
    env_file: .env
    depends_on:
      - api
    restart: unless-stopped
```

(The backtest runner is a one-shot CLI — run it on demand via `docker compose run --rm reliability node src/run/backtest.js`, no long-lived service needed.)

- [ ] **Step 6: Commit**

```bash
git add config/index.js src/run/reliability.js src/run/backtest.js docker-compose.yml test/run/reliability-runner.test.js
git commit -m "feat(legion): add reliability cron and backtest CLI entrypoints"
```

---

### Task 12: Web — reliability board + backtest page

**Files:**
- Modify: `web/src/api/client.js` (add `getReliability`, `getBacktest`)
- Create: `web/src/pages/ReliabilityBoard.jsx`
- Create: `web/src/pages/BacktestPage.jsx`
- Modify: `web/src/App.jsx` (add two tabs)
- Test: `web/test/ReliabilityBoard.test.jsx`, `web/test/BacktestPage.test.jsx`

RTL + jsdom (Phase 3 pattern). Each page fetches on mount, renders an empty state, then rows.

- [ ] **Step 1: Write the failing tests**

```jsx
// web/test/ReliabilityBoard.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ReliabilityBoard from '../src/pages/ReliabilityBoard.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('ReliabilityBoard', () => {
  it('renders each agent with its rho', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([
      { agentId: 'technical', rho: 1.42, sampleSize: 20 },
      { agentId: 'news', rho: 0.81, sampleSize: 15 },
    ]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText('technical')).toBeInTheDocument());
    expect(screen.getByText('1.42')).toBeInTheDocument();
    expect(screen.getByText('news')).toBeInTheDocument();
  });

  it('shows an empty state when no reliability data yet', async () => {
    vi.spyOn(api, 'getReliability').mockResolvedValue([]);
    render(<ReliabilityBoard />);
    await waitFor(() => expect(screen.getByText(/no reliability data/i)).toBeInTheDocument());
  });
});
```

```jsx
// web/test/BacktestPage.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import BacktestPage from '../src/pages/BacktestPage.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('BacktestPage', () => {
  it('renders backtest rows with hit-rate and pnl', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([
      { id: 1, symbol: 'NVDA', horizon: 5, trades: 12, hits: 8, hit_rate: 0.667, pnl: 0.21, spy_pnl: 0.05, qqq_pnl: 0.07 },
    ]);
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('66.7%')).toBeInTheDocument();
  });

  it('shows empty state with no results', async () => {
    vi.spyOn(api, 'getBacktest').mockResolvedValue([]);
    render(<BacktestPage />);
    await waitFor(() => expect(screen.getByText(/no backtest results/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run test/ReliabilityBoard.test.jsx test/BacktestPage.test.jsx`
Expected: FAIL — page modules not found.

- [ ] **Step 3: Add client methods and pages**

In `web/src/api/client.js`, add to the `api` object:

```js
  getReliability: () => get('/api/reliability'),
  getBacktest: (symbol) => get(`/api/backtest${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`),
```

```jsx
// web/src/pages/ReliabilityBoard.jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export default function ReliabilityBoard() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.getReliability().then(setRows).catch(() => setRows([]));
  }, []);

  if (rows && rows.length === 0) {
    return <p className="text-gray-500 p-4">No reliability data yet.</p>;
  }

  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b">
          <th className="p-2">Agent</th>
          <th className="p-2">ρ (reliability)</th>
          <th className="p-2">Sample</th>
        </tr>
      </thead>
      <tbody>
        {(rows ?? []).map((r) => (
          <tr key={r.agentId} className="border-b">
            <td className="p-2 font-medium">{r.agentId}</td>
            <td className="p-2">{r.rho.toFixed(2)}</td>
            <td className="p-2 text-gray-500">{r.sampleSize}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

```jsx
// web/src/pages/BacktestPage.jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { pct } from '../lib/format.js';

export default function BacktestPage() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    api.getBacktest().then(setRows).catch(() => setRows([]));
  }, []);

  if (rows && rows.length === 0) {
    return <p className="text-gray-500 p-4">No backtest results yet.</p>;
  }

  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b">
          <th className="p-2">Symbol</th>
          <th className="p-2">Horizon</th>
          <th className="p-2">Trades</th>
          <th className="p-2">Hit rate</th>
          <th className="p-2">P&amp;L</th>
          <th className="p-2">SPY</th>
          <th className="p-2">QQQ</th>
        </tr>
      </thead>
      <tbody>
        {(rows ?? []).map((r) => (
          <tr key={r.id} className="border-b">
            <td className="p-2 font-medium">{r.symbol}</td>
            <td className="p-2">{r.horizon}d</td>
            <td className="p-2">{r.trades}</td>
            <td className="p-2">{pct(r.hit_rate)}</td>
            <td className="p-2">{pct(r.pnl)}</td>
            <td className="p-2 text-gray-500">{pct(r.spy_pnl)}</td>
            <td className="p-2 text-gray-500">{pct(r.qqq_pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

> `pct` (from Phase 3 `web/src/lib/format.js`) formats a fraction as a percentage, e.g. `pct(0.667)` → `"66.7%"`. Confirm its rounding matches the test's expected `66.7%` (one decimal); if Phase 3's `pct` rounds differently, the test asserts on the actual `pct` output — adjust the expected string to match `pct`, do not change `pct`.

- [ ] **Step 4: Wire the tabs into `web/src/App.jsx`**

Add `ReliabilityBoard` and `BacktestPage` imports and two entries to the tab list (Phase 3 used a local-state tab shell — `Signals | Debate | Config`; extend to `Signals | Debate | Config | Reliability | Backtest`):

```jsx
import ReliabilityBoard from './pages/ReliabilityBoard.jsx';
import BacktestPage from './pages/BacktestPage.jsx';
// add to the tabs array/switch:
//   { id: 'reliability', label: 'Reliability', render: () => <ReliabilityBoard /> }
//   { id: 'backtest', label: 'Backtest', render: () => <BacktestPage /> }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run test/ReliabilityBoard.test.jsx test/BacktestPage.test.jsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Manual browser verification**

Run (three terminals): GunVest API up; `node src/run/api.js`; `cd web && npm run dev`.
1. Seed: run `docker compose run --rm reliability node src/run/backtest.js` (or `node src/run/backtest.js`) to populate `backtest_results` for at least one enabled ticker.
2. Open `http://localhost:5174`, click **Backtest** → see a row per ticker with hit-rate/P&L vs SPY/QQQ.
3. Click **Reliability** → if no signals have resolved yet, confirm the empty state; otherwise rows show ρ per agent.
4. Confirm no console errors.

If you cannot run the full stack, state so explicitly rather than claiming the UI works.

- [ ] **Step 7: Commit**

```bash
git add web/src/api/client.js web/src/pages/ReliabilityBoard.jsx web/src/pages/BacktestPage.jsx web/src/App.jsx web/test/ReliabilityBoard.test.jsx web/test/BacktestPage.test.jsx
git commit -m "feat(legion): add reliability and backtest dashboard pages"
```

---

## Phase 4 — Done. Handover notes

**Shipped:** forward paper-test resolver (signal → forward/SPY/QQQ returns + binary alpha outcome), Brier reliability loop (`ρ_i = clamp(1 + 2(0.25 − meanBrier), 0.5, 1.5)`, neutral 1.0 below 5 resolved), emitter now aggregates with reliability-scaled weights and snapshots per-agent forecasts, deterministic LLM-free backtest (RSI/MACD/SMA quant stance) with hit-rate + P&L vs indices, API routes + dashboard pages for both.

**Effective weight is now live:** `W_i = w_i · ρ_i` actually varies. Before Phase 4 every ρ was 1.0; now the emitter reads `agent_reliability` each cycle. A brand-new deploy still behaves identically to Phase 3 until ≥5 signals per agent resolve (ρ stays 1.0).

**Operational ordering:** signals must accrue and *age past their horizon* before `runReliabilityOnce` can resolve them and move ρ. Expect ρ to stay flat for the first ~`HORIZON_DAYS` of live running. Backtest results populate immediately (historical data), so the Backtest tab is the first thing that shows life.

**Deferred / known gaps:**
- `getSignalStance` is a per-signal extra query in the resolver loop — fine at low signal volume; batch into `listUnresolvedSignals` if it ever gets hot.
- Deterministic backtest indicators are self-contained in `src/backtest/indicators.js`, intentionally **not** shared with the Technical agent's LLM-prompt indicators (different consumers, avoided coupling). If they should converge later, unify behind one module.
- Outcome event is *alpha vs SPY only* (QQQ stored for display, not scored). Revisit if you want a blended benchmark.
- No de-duplication if a ticker is evaluated twice in one horizon window — each emitted signal is scored independently.
- `getCandles` assumes a GunVest `/api/market/:symbol/candles?days=` endpoint returning `{ candles: [{date, close}] }`. **Verify this endpoint exists in GunVest**; if the shape differs, adjust only the mapping in `src/clients/gunvest.js` (Task 3), nothing downstream.

**Next — Phase 5 (summary + polish):** 6h Telegram summary aggregating the window's signals, provider-switch UI (per-agent local/Gemini), add-agent docs, ADRs (consensus, message bus, inference abstraction, deployment), final polish.

---

## Self-Review

**Spec coverage (§9 Backtesting):** Forward paper-test ✓ (Task 5 resolver + Task 11 cron). Index compare ✓ (SPY/QQQ returns in resolution and backtest). Deterministic backtest, no LLM ✓ (Tasks 8-9, pure indicators/engine). Reliability loop via Brier ✓ (Tasks 1, 6). Per-agent ρ leaderboard ✓ (Task 10 API + Task 12 page). "Explicitly not doing" LLM debate replay — honored (backtest uses only `quantStance`).

**Type consistency:** `recordBacktestResult({symbol,horizon,trades,hits,hitRate,pnl,spyPnl,qqqPnl})` ⟷ `runBacktest` return `{trades,hits,hitRate,pnl,spyPnl,qqqPnl}` + `{symbol,horizon}` spread — aligned. `addSignal` returns id ⟷ `addSignalVotes(id, votes)`. `scaleWeights(votes, rhoMap)` ⟷ `getAllReliability()` returns `{agentId: rho}`. `resolveSignal(id, {forwardReturn,spyReturn,qqqReturn,outcome,correct})` ⟷ resolver call site — aligned. `forecastProb`/`brier`/`reliabilityFromBrier` shared between Task 1 (def) and Task 6 (use). Constants (`MIN_RESOLVED`, `WINDOW`) imported, never re-inlined.

**Boundary discipline:** pure math (`reliability.js`, `indicators.js`, `deterministic.js`) has zero I/O and is fully unit-tested; I/O orchestration (`resolver.js`, `update.js`, runners) takes repo/gunvest as injected deps and is tested with stubs; API is data-only; web is presentation-only; they meet at the typed client. No DB required for any test (fake pool + stubs + in-memory bus).

**Supersession, not silent break:** Task 7 extends the Phase 2 emitter; new optional constructor params keep Phase 2 construction valid. Flagged in Task 7 Step 5 that Phase 2 emitter test doubles may need one-line `getAllReliability`/`addSignalVotes` no-op stubs — that is the only Phase 2 test touch and it is called out, not hidden.

**No placeholders:** every step has complete code and an exact run command with expected result. No TBD/TODO. The one judgment call left to the implementer (Phase 3 `pct` rounding format) is explicit and bounded — assert against actual `pct` output, don't modify `pct`.
