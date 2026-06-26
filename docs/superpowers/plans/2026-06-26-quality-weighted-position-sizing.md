# Quality-Weighted Position Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scale Legion's signal conviction by a company-quality multiplier (fundamentals, analyst, valuation, moat) into a position size, applied to two books that share one pure sizing engine: a manual real-holdings book (suggest-only buy/trim deltas) and a live paper book that replaces the deterministic sim (fills at emit-time price, quality-weighted, marked to market vs SPY/QQQ).

**Architecture:** Pure functions for quality scoring, sizing, and the paper-book fold (no I/O, fully unit-tested). Data comes from gunvest's existing REST API via the `gunvest` client (live price already wired; fundamentals via a new client method; analyst via a small gunvest-side add). A new `legion.holdings` table (mirroring gunvest `holdings_cache` columns) holds manual positions, scoped to the authenticated user. The emitter snapshots `qualityMult` onto each signal at emit so the paper book stays a reproducible fold over `legion.signals`.

**Tech Stack:** Node ESM, Express, Postgres (node-pg), vitest, React + recharts (web). LLM provider via `src/llm/provider.js` for moat scoring.

## Global Constraints

- ES modules only (`type: "module"`); `const`/`let`, arrow callbacks, async/await, template literals.
- Postgres schema namespace is `legion`; the single schema file is `src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`).
- Repo data access goes through `db.query(sql, params)` (rows array) and `db.queryOne(sql, params)` (single row) in `src/db/repo.js`.
- All `/api/*` routes are gated by `requireUser`; handlers read `req.user.id` (a `BIGINT`). Follow the `src/api/routes/watchlist.js` handler shape (try/catch → `next(err)`).
- Tests live under `test/` mirroring `src/`, named `*.test.js`, run with `npm test` (vitest). Consolidate all tests for a component in one file (CLAUDE.md).
- Test philosophy: mock as little as possible; inject `fetchImpl`/`now`/dependencies rather than `vi.mock`; use `vi.spyOn` + `vi.restoreAllMocks()` in `afterEach` when spying.
- Module-level constants in PascalCase with an explanatory comment; no magic numbers.
- Run `npm run lint` before any push/PR (CI gates on it).
- Do NOT commit unless the task's Commit step says to; never bypass git hooks.
- Sizing defaults (overridable via opts): `BaseWeight = 0.05`, `MaxPerName = 0.10`, factor weights equal (0.25 each), `RebalanceBandPct = 0.01` (deltas smaller than 1% of portfolio → `hold`). `qualityMult ∈ [0.5, 1.5]`.

---

## Phase A — Real holdings book

### Task 1: `legion.holdings` table + repo CRUD

**Files:**
- Modify: `src/db/schema.sql` (append new table)
- Modify: `src/db/repo.js` (add holdings methods to the returned object)
- Test: `test/db/holdings-repo.test.js` (create)

**Interfaces:**
- Consumes: `db.query`, `db.queryOne` (existing repo db handle).
- Produces:
  - `repo.listHoldings(userId)` → `Array<{ id, ticker, assetType, shares, avgCost, totalCost, realizedPl, dividends, currency, updatedAt }>` (numbers coerced from NUMERIC strings).
  - `repo.upsertHolding(userId, { ticker, shares, avgCost, notes })` → the saved row (same shape). Computes `total_cost = shares * avg_cost`. `ON CONFLICT (user_id, ticker)`.
  - `repo.deleteHolding(userId, ticker)` → `boolean` (true if a row was removed).

- [ ] **Step 1: Append the table to `src/db/schema.sql`** (after the `legion.user_portfolio_config` block)

```sql
-- Manually-entered real holdings (ADR: quality-weighted sizing). Column shape
-- mirrors gunvest's holdings_cache so a later merge into the shared gunvest-db is
-- mechanical. Direct manual entry (no transaction ledger in v1): the user sets
-- shares + avg_cost; total_cost is derived. Scoped per authenticated user.
CREATE TABLE IF NOT EXISTS legion.holdings (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES legion.users(id) ON DELETE CASCADE,
  ticker      TEXT NOT NULL,
  asset_type  TEXT NOT NULL DEFAULT 'stock',
  shares      NUMERIC(18,8) NOT NULL DEFAULT 0,
  avg_cost    NUMERIC(18,8) NOT NULL DEFAULT 0,
  total_cost  NUMERIC(18,8) NOT NULL DEFAULT 0,
  realized_pl NUMERIC(18,8) NOT NULL DEFAULT 0,
  dividends   NUMERIC(18,8) NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'USD',
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, ticker)
);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON legion.holdings (user_id);
```

- [ ] **Step 2: Write the failing test** `test/db/holdings-repo.test.js`

Mirror an existing repo test's harness (see `test/db/` for the in-memory/queryable `db` stub used elsewhere, or a fake that records SQL). Use the same fake-`db` approach the repo tests already use.

```javascript
import { describe, it, expect } from 'vitest';
import { createRepo } from '../../src/db/repo.js';

// Minimal fake db: routes SQL by keyword to canned rows, records calls.
function fakeDb(rowsByMatch = {}) {
  const calls = [];
  const find = (sql) => Object.entries(rowsByMatch).find(([k]) => sql.includes(k))?.[1];
  return {
    calls,
    async query(sql, params) { calls.push({ sql, params }); return find(sql) ?? []; },
    async queryOne(sql, params) { calls.push({ sql, params }); const r = find(sql); return Array.isArray(r) ? r[0] : r ?? null; },
  };
}

describe('holdings repo', () => {
  it('lists holdings with numeric coercion', async () => {
    const db = fakeDb({
      'FROM legion.holdings': [
        { id: 1, ticker: 'NVDA', asset_type: 'stock', shares: '20', avg_cost: '177.04',
          total_cost: '3540.80', realized_pl: '0', dividends: '0', currency: 'USD',
          updated_at: '2026-06-26T00:00:00Z' },
      ],
    });
    const repo = createRepo(db);
    const rows = await repo.listHoldings(7);
    expect(rows[0]).toMatchObject({ ticker: 'NVDA', shares: 20, avgCost: 177.04, totalCost: 3540.8 });
    expect(db.calls[0].params).toEqual([7]);
  });

  it('upsert derives total_cost from shares * avg_cost', async () => {
    const db = fakeDb({ 'INTO legion.holdings': { id: 1, ticker: 'NVDA', shares: '20', avg_cost: '177.04', total_cost: '3540.80', asset_type: 'stock', realized_pl: '0', dividends: '0', currency: 'USD', updated_at: 'x' } });
    const repo = createRepo(db);
    await repo.upsertHolding(7, { ticker: 'nvda', shares: 20, avgCost: 177.04 });
    const call = db.calls.find((c) => c.sql.includes('INTO legion.holdings'));
    expect(call.params).toContain('NVDA'); // upper-cased
    expect(call.params).toContain(3540.8); // total_cost derived
  });

  it('delete returns true when a row was removed', async () => {
    const db = { async query() { return { rowCount: 1 }; }, async queryOne() { return null; } };
    const repo = createRepo(db);
    expect(await repo.deleteHolding(7, 'NVDA')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- test/db/holdings-repo.test.js`
Expected: FAIL (`repo.listHoldings is not a function`).

- [ ] **Step 4: Add the repo methods** in `src/db/repo.js` (inside the returned object, near `getPortfolioConfig`)

```javascript
    async listHoldings(userId) {
      const rows = await db.query(
        `SELECT id, ticker, asset_type, shares, avg_cost, total_cost, realized_pl,
                dividends, currency, notes, updated_at
           FROM legion.holdings WHERE user_id = $1 ORDER BY ticker`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.id,
        ticker: r.ticker,
        assetType: r.asset_type,
        shares: Number(r.shares),
        avgCost: Number(r.avg_cost),
        totalCost: Number(r.total_cost),
        realizedPl: Number(r.realized_pl),
        dividends: Number(r.dividends),
        currency: r.currency,
        notes: r.notes ?? null,
        updatedAt: r.updated_at,
      }));
    },

    async upsertHolding(userId, { ticker, shares, avgCost, assetType = 'stock', notes = null }) {
      const totalCost = Number(shares) * Number(avgCost);
      const row = await db.queryOne(
        `INSERT INTO legion.holdings (user_id, ticker, asset_type, shares, avg_cost, total_cost, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id, ticker) DO UPDATE
           SET shares = EXCLUDED.shares, avg_cost = EXCLUDED.avg_cost,
               total_cost = EXCLUDED.total_cost, asset_type = EXCLUDED.asset_type,
               notes = EXCLUDED.notes, updated_at = now()
         RETURNING id, ticker, asset_type, shares, avg_cost, total_cost, realized_pl,
                   dividends, currency, notes, updated_at`,
        [userId, ticker.toUpperCase(), assetType, shares, avgCost, totalCost, notes],
      );
      return {
        id: row.id, ticker: row.ticker, assetType: row.asset_type,
        shares: Number(row.shares), avgCost: Number(row.avg_cost), totalCost: Number(row.total_cost),
        realizedPl: Number(row.realized_pl), dividends: Number(row.dividends),
        currency: row.currency, notes: row.notes ?? null, updatedAt: row.updated_at,
      };
    },

    async deleteHolding(userId, ticker) {
      const res = await db.query(
        `DELETE FROM legion.holdings WHERE user_id = $1 AND ticker = $2`,
        [userId, ticker.toUpperCase()],
      );
      return (res.rowCount ?? 0) > 0;
    },
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- test/db/holdings-repo.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/repo.js test/db/holdings-repo.test.js
git commit -m "feat: add legion.holdings table and repo CRUD"
```

---

### Task 2: gunvest client `getFundamentals`

**Files:**
- Modify: `src/data/gunvest.js` (add method to the returned object)
- Test: `test/data/gunvest.test.js` (extend existing file)

**Interfaces:**
- Consumes: the existing `get(path)` helper inside `createGunvestClient`.
- Produces: `gunvest.getFundamentals(symbol)` → the parsed body of `GET /api/stocks/:ticker/fundamentals`, e.g. `{ ticker, trailingPE, forwardPE, pegRatio, priceToSales, priceToBook, evToEbitda, revenueGrowth, earningsGrowth, grossMargins, operatingMargins, profitMargins, returnOnEquity, returnOnAssets, debtToEquity, freeCashflow, sector, recommendationKey?, targetMeanPrice?, numberOfAnalystOpinions? }`. Network/parse failures throw (same as sibling methods); callers in the quality service convert to neutral.

- [ ] **Step 1: Write the failing test** (add to `test/data/gunvest.test.js`)

```javascript
it('getFundamentals fetches the gunvest fundamentals endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ ticker: 'NVDA', trailingPE: 45, profitMargins: 0.5 }) };
  };
  const client = createGunvestClient('http://gv', fetchImpl);
  const f = await client.getFundamentals('nvda');
  expect(calls[0]).toBe('http://gv/api/stocks/NVDA/fundamentals');
  expect(f).toMatchObject({ ticker: 'NVDA', trailingPE: 45 });
});
```

(Confirm `createGunvestClient` is already imported at the top of the test file; if not, add `import { createGunvestClient } from '../../src/data/gunvest.js';`.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/data/gunvest.test.js`
Expected: FAIL (`client.getFundamentals is not a function`).

- [ ] **Step 3: Add the method** in `src/data/gunvest.js` (in the returned object, alongside `getPrice`)

```javascript
    getFundamentals: (symbol) => get(`/api/stocks/${symbol.toUpperCase()}/fundamentals`),
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/data/gunvest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/gunvest.js test/data/gunvest.test.js
git commit -m "feat: add getFundamentals to gunvest client"
```

> **Note (cross-repo, tracked separately):** analyst fields (`recommendationKey`, `targetMeanPrice`, `numberOfAnalystOpinions`) require adding `recommendationTrend` to the `quoteSummary` MODULES and mapping `financialData` targets in gunvest's `backend/src/services/market/fundamentalsService.js`, then redeploying gunvest. Until then `getFundamentals` simply omits those keys and the analyst sub-score degrades to neutral (Task 3 handles absence). This is not a blocker for the Legion-side plan.

---

### Task 3: Quality scoring (pure)

**Files:**
- Create: `src/quality/score.js`
- Test: `test/quality/score.test.js` (create)

**Interfaces:**
- Produces:
  - `computeQuality({ fundamentals, analyst, moat, livePrice, weights })` → `{ qualityMult: number, subScores: { fundamentals, valuation, analyst, moat }, flags: string[] }`.
    - `fundamentals` is the gunvest fundamentals object (or `null`); `analyst` is the same object (analyst keys may be absent); `moat` is a number in `[0,1]` or `null`; `livePrice` a number used for analyst target upside.
    - Each of the four sub-scores is a number in `[0,1]` or `null` when its inputs are missing; a `null` sub-score is replaced by `0.5` in the blend and adds a flag like `'quality:fundamentals-missing'`.
    - `qualityMult = 0.5 + weightedBlend` where `weightedBlend ∈ [0,1]`, so `qualityMult ∈ [0.5, 1.5]`.
  - Named helpers (exported for direct testing): `scoreFundamentals(f)`, `scoreValuation(f)`, `scoreAnalyst(f, livePrice)`.

- [ ] **Step 1: Write the failing test** `test/quality/score.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import { computeQuality, scoreFundamentals, scoreValuation, scoreAnalyst } from '../../src/quality/score.js';

describe('quality sub-scores', () => {
  it('scoreValuation rewards cheaper P/E and PEG', () => {
    const cheap = scoreValuation({ trailingPE: 8, pegRatio: 0.7 });
    const rich = scoreValuation({ trailingPE: 55, pegRatio: 2.8 });
    expect(cheap).toBeGreaterThan(rich);
    expect(cheap).toBeLessThanOrEqual(1);
    expect(rich).toBeGreaterThanOrEqual(0);
  });

  it('scoreFundamentals rewards margins/ROE/growth, penalizes debt', () => {
    const strong = scoreFundamentals({ profitMargins: 0.3, returnOnEquity: 0.3, revenueGrowth: 0.3, debtToEquity: 0, freeCashflow: 1e9 });
    const weak = scoreFundamentals({ profitMargins: 0, returnOnEquity: 0, revenueGrowth: 0, debtToEquity: 200, freeCashflow: -1e8 });
    expect(strong).toBeGreaterThan(weak);
  });

  it('scoreAnalyst combines rating and target upside', () => {
    const bull = scoreAnalyst({ recommendationKey: 'strong_buy', targetMeanPrice: 150, numberOfAnalystOpinions: 30 }, 100);
    const bear = scoreAnalyst({ recommendationKey: 'sell', targetMeanPrice: 90, numberOfAnalystOpinions: 30 }, 100);
    expect(bull).toBeGreaterThan(bear);
  });

  it('scoreAnalyst returns null when no analyst coverage', () => {
    expect(scoreAnalyst({}, 100)).toBeNull();
  });
});

describe('computeQuality', () => {
  it('maps an average company to ~1.0 and clamps to [0.5,1.5]', () => {
    const q = computeQuality({
      fundamentals: { profitMargins: 0.15, returnOnEquity: 0.15, revenueGrowth: 0.15, debtToEquity: 100, freeCashflow: 1, trailingPE: 30, pegRatio: 1.75 },
      analyst: { recommendationKey: 'hold', targetMeanPrice: 100, numberOfAnalystOpinions: 10 },
      moat: 0.5, livePrice: 100,
    });
    expect(q.qualityMult).toBeGreaterThanOrEqual(0.5);
    expect(q.qualityMult).toBeLessThanOrEqual(1.5);
    expect(q.qualityMult).toBeCloseTo(1.0, 1);
    expect(q.flags).toEqual([]);
  });

  it('degrades missing factors to neutral and flags them', () => {
    const q = computeQuality({ fundamentals: null, analyst: null, moat: null, livePrice: 100 });
    expect(q.qualityMult).toBeCloseTo(1.0, 5); // all neutral 0.5 → blend 0.5 → mult 1.0
    expect(q.flags).toContain('quality:fundamentals-missing');
    expect(q.flags).toContain('quality:analyst-missing');
    expect(q.flags).toContain('quality:moat-missing');
    expect(q.flags).toContain('quality:valuation-missing');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/quality/score.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/quality/score.js`**

```javascript
// Pure company-quality scoring. Four sub-scores, each normalized to [0,1], blend
// to a multiplier in [0.5, 1.5] that scales signal conviction in the sizing
// engine. No I/O — all inputs are passed in (gunvest fundamentals object, a moat
// score, and the live price for analyst target upside). A missing factor degrades
// to a neutral 0.5 and raises a flag rather than blocking the score (mirrors the
// risk-manager fallback).

const QualityFloor = 0.5; // qualityMult range is [0.5, 1.5]
const NeutralSub = 0.5; // a missing sub-score contributes this to the blend
const DefaultWeights = { fundamentals: 0.25, valuation: 0.25, analyst: 0.25, moat: 0.25 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Map a value linearly from [lo, hi] onto [0, 1] (hi may be < lo to invert).
function ramp(v, lo, hi) {
  if (v == null || Number.isNaN(v)) return null;
  return clamp01((v - lo) / (hi - lo));
}

export function scoreFundamentals(f) {
  if (!f) return null;
  const parts = [
    ramp(f.profitMargins, 0, 0.3),
    ramp(f.returnOnEquity, 0, 0.3),
    ramp(f.revenueGrowth, 0, 0.3),
    ramp(f.debtToEquity, 200, 0), // lower debt → higher score (inverted ramp)
    f.freeCashflow == null ? null : (f.freeCashflow > 0 ? 1 : 0),
  ].filter((x) => x != null);
  return parts.length ? avg(parts) : null;
}

export function scoreValuation(f) {
  if (!f) return null;
  // No positive earnings (PE <= 0) is a valuation risk, not a freebie: neutral-low.
  const peScore = f.trailingPE == null ? null : (f.trailingPE <= 0 ? 0.3 : ramp(f.trailingPE, 60, 5));
  const pegScore = ramp(f.pegRatio, 3, 0.5);
  const parts = [peScore, pegScore].filter((x) => x != null);
  return parts.length ? avg(parts) : null;
}

const RatingScore = {
  strong_buy: 1, buy: 0.75, outperform: 0.7, hold: 0.5, neutral: 0.5,
  underperform: 0.3, sell: 0.25, strong_sell: 0,
};

export function scoreAnalyst(f, livePrice) {
  if (!f || !f.numberOfAnalystOpinions) return null;
  const parts = [];
  if (f.recommendationKey && RatingScore[f.recommendationKey] != null) {
    parts.push(RatingScore[f.recommendationKey]);
  }
  if (f.targetMeanPrice && livePrice) {
    const upside = (f.targetMeanPrice - livePrice) / livePrice;
    parts.push(ramp(upside, -0.2, 0.5)); // -20%..+50% target upside → [0,1]
  }
  return parts.length ? avg(parts) : null;
}

export function computeQuality({ fundamentals, analyst, moat, livePrice, weights = DefaultWeights }) {
  const subScores = {
    fundamentals: scoreFundamentals(fundamentals),
    valuation: scoreValuation(fundamentals),
    analyst: scoreAnalyst(analyst, livePrice),
    moat: moat == null ? null : clamp01(moat),
  };
  const flags = [];
  let blend = 0;
  for (const key of Object.keys(weights)) {
    const s = subScores[key];
    if (s == null) flags.push(`quality:${key}-missing`);
    blend += weights[key] * (s == null ? NeutralSub : s);
  }
  return { qualityMult: QualityFloor + clamp01(blend), subScores, flags };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/quality/score.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/quality/score.js test/quality/score.test.js
git commit -m "feat: add pure company-quality scoring"
```

---

### Task 4: Moat scorer (LLM, injectable)

**Files:**
- Create: `src/quality/moat.js`
- Test: `test/quality/moat.test.js` (create)

**Interfaces:**
- Produces: `createMoatScorer({ provider, gunvest, logger })` → `async (symbol) => number|null`. Asks the LLM to rate competitive durability `[0,1]` from the symbol's name/sector + recent news; returns `null` on any failure (so quality degrades to neutral). `provider` matches the `src/llm/provider.js` interface (`async complete({ prompt }) => string` — confirm the exact method name against `src/llm/provider.js` and use it).

- [ ] **Step 1: Verify the provider call shape**

Run: `grep -nE "complete|generate|async .*prompt" src/llm/provider.js src/llm/ollama.js`
Expected: identify the provider's completion method (e.g. `complete({ prompt })`). Use that exact name below in place of `complete`.

- [ ] **Step 2: Write the failing test** `test/quality/moat.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import { createMoatScorer } from '../../src/quality/moat.js';

const fakeGunvest = { getFundamentals: async () => ({ sector: 'Technology' }), getNews: async () => ({ items: [] }) };

describe('moat scorer', () => {
  it('parses a [0,1] score from the LLM reply', async () => {
    const provider = { complete: async () => 'MOAT: 0.8 — strong network effects' };
    const score = await createMoatScorer({ provider, gunvest: fakeGunvest })('META');
    expect(score).toBeCloseTo(0.8, 5);
  });

  it('returns null when the LLM fails', async () => {
    const provider = { complete: async () => { throw new Error('llm down'); } };
    const score = await createMoatScorer({ provider, gunvest: fakeGunvest })('META');
    expect(score).toBeNull();
  });

  it('returns null on an unparseable reply', async () => {
    const provider = { complete: async () => 'no number here' };
    expect(await createMoatScorer({ provider, gunvest: fakeGunvest })('META')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- test/quality/moat.test.js`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/quality/moat.js`** (use the confirmed provider method name)

```javascript
// LLM moat scorer: rates a company's competitive durability (pricing power,
// switching costs, network effects, scale) on [0,1]. Injectable provider +
// gunvest client; any failure returns null so the quality blend degrades to a
// neutral moat rather than blocking sizing.

const MoatRe = /MOAT:\s*([01](?:\.\d+)?)/i;

export function createMoatScorer({ provider, gunvest, logger = console }) {
  return async (symbol) => {
    try {
      const f = await gunvest.getFundamentals(symbol).catch(() => ({}));
      const sector = f?.sector ?? 'unknown';
      const prompt =
        `Rate the durable competitive moat of ${symbol} (sector: ${sector}) on a ` +
        `scale of 0 to 1, where 0 = no moat (commodity, easily disrupted) and ` +
        `1 = wide durable moat (pricing power, high switching costs, network ` +
        `effects, or scale). Reply with exactly one line: "MOAT: <score>" then a ` +
        `short reason.`;
      const reply = await provider.complete({ prompt });
      const m = MoatRe.exec(reply);
      if (!m) return null;
      const score = Number(m[1]);
      return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
    } catch (err) {
      logger.warn?.(`[moat] scoring failed for ${symbol}: ${err.message}`);
      return null;
    }
  };
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- test/quality/moat.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/quality/moat.js test/quality/moat.test.js
git commit -m "feat: add injectable LLM moat scorer"
```

---

### Task 5: Quality service (fetch + cache)

**Files:**
- Create: `src/quality/index.js`
- Test: `test/quality/service.test.js` (create)

**Interfaces:**
- Consumes: `gunvest.getFundamentals`, the moat scorer from Task 4 (optional), `createTtlCache` from `src/data/feeds/cache.js`, `computeQuality` from Task 3.
- Produces: `createQualityService({ gunvest, moatScorer = null, cache = createTtlCache(), ttlMs = DailyTtlMs, logger })` → `{ getQuality(symbol, livePrice) }` where `getQuality` returns `{ qualityMult, subScores, flags }`. Caches per `symbol` for `ttlMs` (livePrice only affects the analyst target term; cache key is the symbol, and a stale price within a day is acceptable). gunvest failure → fundamentals `null` (neutral + flag), never throws.

- [ ] **Step 1: Write the failing test** `test/quality/service.test.js`

```javascript
import { describe, it, expect, vi } from 'vitest';
import { createQualityService } from '../../src/quality/index.js';

describe('quality service', () => {
  it('fetches fundamentals + moat and returns a qualityMult', async () => {
    const gunvest = { getFundamentals: vi.fn(async () => ({ trailingPE: 20, pegRatio: 1, profitMargins: 0.2, returnOnEquity: 0.2, revenueGrowth: 0.2, debtToEquity: 50, freeCashflow: 1, numberOfAnalystOpinions: 5, recommendationKey: 'buy', targetMeanPrice: 120 })) };
    const moatScorer = async () => 0.7;
    const svc = createQualityService({ gunvest, moatScorer });
    const q = await svc.getQuality('NVDA', 100);
    expect(q.qualityMult).toBeGreaterThan(1.0);
    expect(gunvest.getFundamentals).toHaveBeenCalledWith('NVDA');
  });

  it('caches within the TTL (one fetch for two calls)', async () => {
    const gunvest = { getFundamentals: vi.fn(async () => ({ trailingPE: 20 })) };
    const svc = createQualityService({ gunvest });
    await svc.getQuality('NVDA', 100);
    await svc.getQuality('NVDA', 100);
    expect(gunvest.getFundamentals).toHaveBeenCalledTimes(1);
  });

  it('degrades to neutral when gunvest throws', async () => {
    const gunvest = { getFundamentals: vi.fn(async () => { throw new Error('down'); }) };
    const svc = createQualityService({ gunvest });
    const q = await svc.getQuality('NVDA', 100);
    expect(q.qualityMult).toBeCloseTo(1.0, 5);
    expect(q.flags).toContain('quality:fundamentals-missing');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/quality/service.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/quality/index.js`**

```javascript
import { createTtlCache } from '../data/feeds/cache.js';
import { computeQuality } from './score.js';

// Daily TTL: fundamentals + moat move on a daily/weekly cadence, so one fetch per
// symbol per day is plenty. gunvest caches its own Yahoo calls underneath.
const DailyTtlMs = 24 * 60 * 60 * 1000;

export function createQualityService({
  gunvest,
  moatScorer = null,
  cache = createTtlCache(),
  ttlMs = DailyTtlMs,
  logger = console,
}) {
  async function getQuality(symbol, livePrice) {
    return cache.getOrFetch(`quality:${symbol.toUpperCase()}`, ttlMs, async () => {
      const fundamentals = await gunvest.getFundamentals(symbol).catch((err) => {
        logger.warn?.(`[quality] fundamentals fetch failed for ${symbol}: ${err.message}`);
        return null;
      });
      const moat = moatScorer ? await moatScorer(symbol).catch(() => null) : null;
      // The fundamentals object carries analyst keys when gunvest exposes them.
      return computeQuality({ fundamentals, analyst: fundamentals, moat, livePrice });
    });
  }
  return { getQuality };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/quality/service.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/quality/index.js test/quality/service.test.js
git commit -m "feat: add quality service with daily cache"
```

---

### Task 6: Sizing engine (pure)

**Files:**
- Create: `src/sizing/engine.js`
- Test: `test/sizing/engine.test.js` (create)

**Interfaces:**
- Produces:
  - `BAND_LONG` (Set of `'BUY'`, `'STRONG_BUY'`).
  - `computeSizing({ signal, qualityMult, position, livePrice, portfolioValue, config })` → one recommendation row:
    `{ ticker, band, conviction, qualityMult, currentWeight, targetWeight, marketValue, deltaUSD, deltaShares, action, unrealizedPnl, unrealizedPnlPct, flags }`.
    - `signal`: `{ symbol, band, conviction }` or `null` (→ treated as `NO_CONSENSUS`).
    - `position`: `{ shares, avgCost }` or `null` (→ shares 0).
    - `config`: `{ baseWeight, maxPerName, rebalanceBandPct }`.
  - `buildSizingBook({ holdings, signalsBySymbol, qualityBySymbol, pricesBySymbol, config })` → `{ rows, summary }` where `summary = { totalValue, totalCost, unrealizedPnl, targetInvestedPct }`. Computes `totalValue` first (sum of `shares × livePrice`), then sizes each holding against it.

- [ ] **Step 1: Write the failing test** `test/sizing/engine.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import { computeSizing, buildSizingBook } from '../../src/sizing/engine.js';

const config = { baseWeight: 0.05, maxPerName: 0.10, rebalanceBandPct: 0.01 };

describe('computeSizing', () => {
  it('targets baseWeight × conviction × qualityMult, clamped to maxPerName', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'STRONG_BUY', conviction: 1 },
      qualityMult: 1.5, position: { shares: 0, avgCost: 0 },
      livePrice: 100, portfolioValue: 10000, config,
    });
    // 0.05 × 1 × 1.5 = 0.075 < 0.10 cap
    expect(row.targetWeight).toBeCloseTo(0.075, 5);
    expect(row.action).toBe('buy');
    expect(row.deltaUSD).toBeCloseTo(750, 5);
    expect(row.deltaShares).toBeCloseTo(7.5, 5);
  });

  it('clamps to maxPerName', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'STRONG_BUY', conviction: 1 },
      qualityMult: 1.5, position: { shares: 0, avgCost: 0 },
      livePrice: 100, portfolioValue: 10000, config: { ...config, baseWeight: 0.1 },
    });
    expect(row.targetWeight).toBe(0.10);
  });

  it('SELL / NO_CONSENSUS / missing signal → target 0 and trim', () => {
    for (const signal of [{ symbol: 'X', band: 'SELL', conviction: 1 }, { symbol: 'X', band: 'NO_CONSENSUS', conviction: 0 }, null]) {
      const row = computeSizing({ signal, qualityMult: 1.5, position: { shares: 10, avgCost: 5 }, livePrice: 10, portfolioValue: 1000, config });
      expect(row.targetWeight).toBe(0);
      expect(row.action).toBe('trim');
    }
  });

  it('computes unrealized P/L and current weight', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 0.5 },
      qualityMult: 1, position: { shares: 10, avgCost: 80 },
      livePrice: 100, portfolioValue: 2000, config,
    });
    expect(row.marketValue).toBe(1000);
    expect(row.currentWeight).toBeCloseTo(0.5, 5);
    expect(row.unrealizedPnl).toBe(200);
    expect(row.unrealizedPnlPct).toBeCloseTo(0.25, 5);
  });

  it('within the rebalance band → hold', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 1 },
      qualityMult: 1, position: { shares: 5, avgCost: 100 }, // 500 of 10000 = 5% current; target 5%
      livePrice: 100, portfolioValue: 10000, config,
    });
    expect(row.action).toBe('hold');
  });

  it('flags a stale price', () => {
    const row = computeSizing({
      signal: { symbol: 'NVDA', band: 'BUY', conviction: 1 }, qualityMult: 1,
      position: { shares: 1, avgCost: 1 }, livePrice: null, portfolioValue: 100,
      config, priceStale: true,
    });
    expect(row.flags).toContain('sizing:stale-price');
  });
});

describe('buildSizingBook', () => {
  it('sizes every holding against the live total value', () => {
    const { rows, summary } = buildSizingBook({
      holdings: [{ ticker: 'NVDA', shares: 10, avgCost: 80 }, { ticker: 'AMD', shares: 5, avgCost: 100 }],
      signalsBySymbol: { NVDA: { symbol: 'NVDA', band: 'BUY', conviction: 1 }, AMD: { symbol: 'AMD', band: 'SELL', conviction: 1 } },
      qualityBySymbol: { NVDA: { qualityMult: 1, flags: [] }, AMD: { qualityMult: 1, flags: [] } },
      pricesBySymbol: { NVDA: { price: 100 }, AMD: { price: 120 } },
      config,
    });
    expect(summary.totalValue).toBe(10 * 100 + 5 * 120); // 1600
    expect(rows.find((r) => r.ticker === 'AMD').action).toBe('trim');
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/sizing/engine.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/sizing/engine.js`**

```javascript
// Pure position-sizing engine, shared by the real-holdings book and the live
// paper book. targetWeight = clamp(baseWeight × conviction × qualityMult, 0,
// maxPerName) for long signals; SELL / NO_CONSENSUS / no-signal → target 0.
// No I/O — callers pass signals, quality, positions, and live prices.

export const BAND_LONG = new Set(['BUY', 'STRONG_BUY']);

const DefaultConfig = { baseWeight: 0.05, maxPerName: 0.10, rebalanceBandPct: 0.01 };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function computeSizing({ signal, qualityMult, position, livePrice, portfolioValue, config = DefaultConfig, priceStale = false }) {
  const { baseWeight, maxPerName, rebalanceBandPct } = { ...DefaultConfig, ...config };
  const shares = position?.shares ?? 0;
  const avgCost = position?.avgCost ?? 0;
  const price = Number(livePrice) || 0;
  const flags = [];
  if (priceStale || !price) flags.push('sizing:stale-price');

  const band = signal?.band ?? 'NO_CONSENSUS';
  const conviction = Number(signal?.conviction ?? 0);
  const isLong = BAND_LONG.has(band) && conviction > 0;
  const targetWeight = isLong ? clamp(baseWeight * conviction * qualityMult, 0, maxPerName) : 0;

  const marketValue = shares * price;
  const currentWeight = portfolioValue > 0 ? marketValue / portfolioValue : 0;
  const deltaUSD = (targetWeight - currentWeight) * portfolioValue;
  const deltaShares = price > 0 ? deltaUSD / price : 0;
  const unrealizedPnl = (price - avgCost) * shares;
  const cost = avgCost * shares;
  const unrealizedPnlPct = cost > 0 ? unrealizedPnl / cost : 0;

  let action = 'hold';
  if (Math.abs(deltaUSD) >= rebalanceBandPct * portfolioValue) action = deltaUSD > 0 ? 'buy' : 'trim';

  return {
    ticker: signal?.symbol ?? position?.ticker ?? null,
    band, conviction, qualityMult,
    currentWeight, targetWeight, marketValue,
    deltaUSD, deltaShares, action,
    unrealizedPnl, unrealizedPnlPct, flags,
  };
}

export function buildSizingBook({ holdings, signalsBySymbol, qualityBySymbol, pricesBySymbol, config = DefaultConfig }) {
  const priceOf = (t) => Number(pricesBySymbol[t]?.price) || 0;
  const totalValue = holdings.reduce((s, h) => s + h.shares * priceOf(h.ticker), 0);
  const totalCost = holdings.reduce((s, h) => s + h.shares * h.avgCost, 0);

  const rows = holdings.map((h) => {
    const q = qualityBySymbol[h.ticker] ?? { qualityMult: 1, flags: ['quality:missing'] };
    const price = pricesBySymbol[h.ticker]?.price;
    const row = computeSizing({
      signal: signalsBySymbol[h.ticker] ?? null,
      qualityMult: q.qualityMult,
      position: { shares: h.shares, avgCost: h.avgCost, ticker: h.ticker },
      livePrice: price,
      portfolioValue: totalValue,
      config,
      priceStale: price == null,
    });
    row.ticker = h.ticker;
    row.flags = [...row.flags, ...(q.flags ?? [])];
    return row;
  });

  const targetInvestedPct = rows.reduce((s, r) => s + r.targetWeight, 0);
  return {
    rows,
    summary: { totalValue, totalCost, unrealizedPnl: totalValue - totalCost, targetInvestedPct },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/sizing/engine.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sizing/engine.js test/sizing/engine.test.js
git commit -m "feat: add pure quality-weighted sizing engine"
```

---

### Task 7: Holdings CRUD + sizing API routes

**Files:**
- Create: `src/api/routes/holdings.js`
- Modify: `src/api/app.js` (import + mount; pass quality service)
- Modify: `src/run/api.js` (construct the quality service and pass it into the app)
- Test: `test/api/holdings.test.js` (create)

**Interfaces:**
- Consumes: `repo.listHoldings/upsertHolding/deleteHolding` (Task 1), `repo.listAllSignals` (existing — returns `{ symbol, band, conviction, plan, ... }`), `gunvest.getPrice` (existing), `qualityService.getQuality` (Task 5), `buildSizingBook` (Task 6).
- Produces: an Express router with
  - `GET /api/holdings` → `{ holdings: [...] }`
  - `PUT /api/holdings/:ticker` body `{ shares, avgCost, notes? }` → `{ holdings: [...] }` (201)
  - `DELETE /api/holdings/:ticker` → `{ holdings: [...] }`
  - `GET /api/holdings/sizing` → `{ rows, summary }` from the engine.

- [ ] **Step 1: Write the failing test** `test/api/holdings.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { holdingsRoutes } from '../../src/api/routes/holdings.js';

function appWith(repo, gunvest, quality) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use('/api/holdings', holdingsRoutes(repo, gunvest, quality));
  return app;
}

describe('holdings routes', () => {
  const baseRepo = {
    holdings: [{ ticker: 'NVDA', shares: 10, avgCost: 80 }],
    async listHoldings() { return this.holdings; },
    async upsertHolding(_u, h) { this.holdings = [{ ticker: h.ticker.toUpperCase(), shares: h.shares, avgCost: h.avgCost }]; return this.holdings[0]; },
    async deleteHolding() { this.holdings = []; return true; },
    async listAllSignals() { return [{ symbol: 'NVDA', band: 'BUY', conviction: 1, plan: { qualityMult: 1.2 } }]; },
  };
  const gunvest = { getPrice: async () => ({ price: 100 }) };
  const quality = { getQuality: async () => ({ qualityMult: 1.2, flags: [] }) };

  it('lists holdings', async () => {
    const res = await request(appWith(baseRepo, gunvest, quality)).get('/api/holdings');
    expect(res.status).toBe(200);
    expect(res.body.holdings[0].ticker).toBe('NVDA');
  });

  it('upserts a holding', async () => {
    const repo = { ...baseRepo, holdings: [...baseRepo.holdings] };
    const res = await request(appWith(repo, gunvest, quality)).put('/api/holdings/amd').send({ shares: 5, avgCost: 100 });
    expect(res.status).toBe(201);
  });

  it('returns a sizing book', async () => {
    const res = await request(appWith(baseRepo, gunvest, quality)).get('/api/holdings/sizing');
    expect(res.status).toBe(200);
    expect(res.body.rows[0].ticker).toBe('NVDA');
    expect(res.body.summary.totalValue).toBe(1000);
  });
});
```

(If `supertest` is not already a dev dependency, check `package.json`; existing API tests likely use it. If they use a different harness, mirror that harness instead.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/api/holdings.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/api/routes/holdings.js`**

```javascript
import { Router } from 'express';
import { buildSizingBook } from '../../sizing/engine.js';

// Per-user real-holdings book. CRUD over legion.holdings plus a /sizing endpoint
// that joins holdings + latest signals + live price + cached quality through the
// shared pure sizing engine. Suggest-only — never trades.
export function holdingsRoutes(repo, gunvest, quality) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ holdings: await repo.listHoldings(req.user.id) });
    } catch (err) { next(err); }
  });

  router.put('/:ticker', async (req, res, next) => {
    try {
      const { shares, avgCost, notes } = req.body ?? {};
      if (!(Number(shares) >= 0) || !(Number(avgCost) >= 0)) {
        return res.status(400).json({ error: 'shares and avgCost must be non-negative numbers' });
      }
      await repo.upsertHolding(req.user.id, { ticker: req.params.ticker, shares: Number(shares), avgCost: Number(avgCost), notes });
      res.status(201).json({ holdings: await repo.listHoldings(req.user.id) });
    } catch (err) { next(err); }
  });

  router.delete('/:ticker', async (req, res, next) => {
    try {
      await repo.deleteHolding(req.user.id, req.params.ticker);
      res.json({ holdings: await repo.listHoldings(req.user.id) });
    } catch (err) { next(err); }
  });

  router.get('/sizing', async (req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      const holdings = await repo.listHoldings(req.user.id);
      const symbols = [...new Set(holdings.map((h) => h.ticker))];

      // Latest signal per symbol (listAllSignals is oldest-first; last write wins).
      const signalsBySymbol = {};
      for (const s of await repo.listAllSignals()) {
        if (symbols.includes(s.symbol)) signalsBySymbol[s.symbol] = s;
      }

      const pricesBySymbol = {};
      const qualityBySymbol = {};
      await Promise.all(symbols.map(async (sym) => {
        const price = await gunvest.getPrice(sym).catch(() => null);
        pricesBySymbol[sym] = price ?? {};
        qualityBySymbol[sym] = await quality.getQuality(sym, price?.price).catch(() => ({ qualityMult: 1, flags: ['quality:error'] }));
      }));

      res.json(buildSizingBook({ holdings, signalsBySymbol, qualityBySymbol, pricesBySymbol, config: {} }));
    } catch (err) { next(err); }
  });

  return router;
}
```

> Route order note: register `GET /sizing` is on a literal path, so Express matches it before `/:ticker` for GET only when paths differ by method; since `/sizing` is a GET and `/:ticker` GET does not exist, there is no conflict. (There is no `GET /:ticker`.)

- [ ] **Step 4: Wire the quality service + mount the routes**

In `src/run/api.js`, construct the quality service from the existing `gunvest` client and pass it into the app builder. Find where the app is created and add (adjust import paths to match the file):

```javascript
import { createQualityService } from '../quality/index.js';
// ...
const quality = createQualityService({ gunvest });
// pass `quality` into createApp(...) alongside repo/gunvest
```

In `src/api/app.js`, accept `quality` in the app factory signature and mount the router next to the others:

```javascript
import { holdingsRoutes } from './routes/holdings.js';
// ...
app.use('/api/holdings', holdingsRoutes(repo, gunvest, quality));
```

- [ ] **Step 5: Run the test + full suite**

Run: `npm test -- test/api/holdings.test.js`
Expected: PASS.
Run: `npm test`
Expected: PASS (no regressions). Then `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/holdings.js src/api/app.js src/run/api.js test/api/holdings.test.js
git commit -m "feat: add holdings CRUD and sizing API"
```

---

### Task 8: Web — holdings entry + sizing table

**Files:**
- Modify: `web/src/api/client.js` (add holdings/sizing calls)
- Create: `web/src/pages/HoldingsPage.jsx`
- Modify: the app's route registry (where `PortfolioPage` is registered — find via `grep -rn "PortfolioPage" web/src`) to add a `/holdings` route + nav link
- Test: `web/test/pages/HoldingsPage.test.jsx` (create)

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/holdings`, `GET /api/holdings/sizing`.
- Produces: `api.getHoldings()`, `api.saveHolding(ticker, { shares, avgCost })`, `api.deleteHolding(ticker)`, `api.getSizing()`; a `HoldingsPage` rendering an entry form + a recommendations table (current weight → target, buy/trim $, P/L, quality flags), polling sizing every 20s.

- [ ] **Step 1: Inspect the api client + a page test for the established pattern**

Run: `grep -nE "getPortfolio|export const api|function get" web/src/api/client.js` and open `web/test/pages/PortfolioPage.test.jsx` to mirror its mocking style.

- [ ] **Step 2: Write the failing test** `web/test/pages/HoldingsPage.test.jsx`

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HoldingsPage } from '../../src/pages/HoldingsPage.jsx';
import { api } from '../../src/api/client.js';

vi.mock('../../src/api/client.js', () => ({
  api: { getHoldings: vi.fn(), getSizing: vi.fn(), saveHolding: vi.fn(), deleteHolding: vi.fn() },
}));

describe('HoldingsPage', () => {
  beforeEach(() => {
    api.getHoldings.mockResolvedValue({ holdings: [{ ticker: 'NVDA', shares: 10, avgCost: 80 }] });
    api.getSizing.mockResolvedValue({
      rows: [{ ticker: 'NVDA', currentWeight: 0.5, targetWeight: 0.075, deltaUSD: -425, action: 'trim', unrealizedPnl: 200, unrealizedPnlPct: 0.25, flags: [] }],
      summary: { totalValue: 1000, totalCost: 800, unrealizedPnl: 200, targetInvestedPct: 0.075 },
    });
  });

  it('renders the sizing table with a recommended action', async () => {
    render(<HoldingsPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText(/trim/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd web && npm test -- test/pages/HoldingsPage.test.jsx` (or the repo's web test command; check `web/package.json`).
Expected: FAIL (module not found).

- [ ] **Step 4: Add the api client calls** in `web/src/api/client.js` (match the existing `get`/`request` helper names in that file)

```javascript
  getHoldings: () => get('/api/holdings'),
  getSizing: () => get('/api/holdings/sizing'),
  saveHolding: (ticker, body) => request('PUT', `/api/holdings/${ticker}`, body),
  deleteHolding: (ticker) => request('DELETE', `/api/holdings/${ticker}`),
```

- [ ] **Step 5: Implement `web/src/pages/HoldingsPage.jsx`** (mirror `PortfolioPage.jsx` imports/helpers)

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { pct } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

const money = (v) => `$${Math.round(v ?? 0).toLocaleString('en-US')}`;
const gainColor = (v) => (v >= 0 ? 'text-green-600' : 'text-red-600');
const PollMs = 20000;

const actionColor = { buy: 'text-green-600', trim: 'text-red-600', hold: 'text-slate-500' };

export function HoldingsPage() {
  const [holdings, setHoldings] = useState([]);
  const [sizing, setSizing] = useState(null);
  const [form, setForm] = useState({ ticker: '', shares: '', avgCost: '' });
  const [error, setError] = useState(null);

  const refresh = () => {
    api.getHoldings().then((d) => setHoldings(d.holdings)).catch((e) => setError(e.message));
    api.getSizing().then(setSizing).catch((e) => setError(e.message));
  };

  useEffect(() => {
    refresh();
    const id = setInterval(() => api.getSizing().then(setSizing).catch(() => {}), PollMs);
    return () => clearInterval(id);
  }, []);

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.saveHolding(form.ticker, { shares: Number(form.shares), avgCost: Number(form.avgCost) });
      setForm({ ticker: '', shares: '', avgCost: '' });
      refresh();
    } catch (err) { setError(err.message); }
  };

  const remove = async (ticker) => { await api.deleteHolding(ticker); refresh(); };

  return (
    <div>
      <PageHeader title="Holdings" subtitle="Your real positions, sized by signal conviction × company quality" />
      {error && <p className="mb-3 text-red-600">{error}</p>}

      <Card className="mb-5 p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={save}>
          <label className="text-sm">Ticker
            <input className="ml-2 rounded border px-2 py-1" value={form.ticker}
              onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} required />
          </label>
          <label className="text-sm">Shares
            <input className="ml-2 w-24 rounded border px-2 py-1" type="number" step="any" value={form.shares}
              onChange={(e) => setForm({ ...form, shares: e.target.value })} required />
          </label>
          <label className="text-sm">Avg cost
            <input className="ml-2 w-28 rounded border px-2 py-1" type="number" step="any" value={form.avgCost}
              onChange={(e) => setForm({ ...form, avgCost: e.target.value })} required />
          </label>
          <button className="rounded bg-indigo-600 px-3 py-1 text-white" type="submit">Save</button>
        </form>
      </Card>

      {sizing && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Total value</p><p className="text-xl font-semibold">{money(sizing.summary.totalValue)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Unrealized P/L</p><p className={`text-xl font-semibold ${gainColor(sizing.summary.unrealizedPnl)}`}>{money(sizing.summary.unrealizedPnl)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Target invested</p><p className="text-xl font-semibold">{pct(sizing.summary.targetInvestedPct)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Positions</p><p className="text-xl font-semibold">{holdings.length}</p></Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              {['Symbol', 'Now →', 'Target', 'Buy/Trim', 'Unrealized', 'Action', ''].map((h) => (
                <th key={h} className="px-4 py-2 font-medium text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(sizing?.rows ?? []).map((r) => (
              <tr key={r.ticker} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{r.ticker}{r.flags?.length ? <span title={r.flags.join(', ')} className="ml-1 text-amber-500">⚠</span> : null}</td>
                <td className="px-4 py-2">{pct(r.currentWeight)}</td>
                <td className="px-4 py-2">{pct(r.targetWeight)}</td>
                <td className={`px-4 py-2 ${gainColor(r.deltaUSD)}`}>{money(r.deltaUSD)}</td>
                <td className={`px-4 py-2 ${gainColor(r.unrealizedPnl)}`}>{money(r.unrealizedPnl)} ({pct(r.unrealizedPnlPct, 1)})</td>
                <td className={`px-4 py-2 font-medium ${actionColor[r.action] ?? ''}`}>{r.action}</td>
                <td className="px-4 py-2"><button className="text-slate-400 hover:text-red-600" onClick={() => remove(r.ticker)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 6: Register the route + nav link**

Add `HoldingsPage` to the web router/nav next to Portfolio (mirror how `PortfolioPage` is registered — the exact file came from the Step 1 grep).

- [ ] **Step 7: Run the web test + lint**

Run: `cd web && npm test -- test/pages/HoldingsPage.test.jsx` → PASS.
Run: `cd web && npm run lint` (if defined) and the root `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add web/src/api/client.js web/src/pages/HoldingsPage.jsx web/test/pages/HoldingsPage.test.jsx
git commit -m "feat: add holdings page with quality-weighted sizing table"
```

---

## Phase B — Live paper book (replaces deterministic sim)

### Task 9: Snapshot `qualityMult` onto the signal at emit

**Files:**
- Modify: `src/emit/emitter.js` (`finalize`, and the `createEmitter` signature)
- Modify: `src/run/emitter.js` (construct + inject the quality service)
- Test: `test/emit/emitter.test.js` (extend) or `test/emit/emitter-quality.test.js` (create)

**Interfaces:**
- Consumes: an optional `quality` dependency with `getQuality(symbol, livePrice)` (Task 5).
- Produces: every emitted signal's `plan` JSONB carries `qualityMult` (and `qualityFlags`). On quality failure or no `quality` injected, `qualityMult` defaults to `1.0` and the hot path never blocks (mirrors the existing `entryPrice` try/catch).

- [ ] **Step 1: Write the failing test** (new file `test/emit/emitter-quality.test.js`, or extend the emitter test)

Drive `finalize` via the public path the existing emitter tests use (publishing votes through a fake bus). Assert the persisted signal's `plan.qualityMult`. Mirror the existing emitter test harness for bus/repo fakes; the new assertions are:

```javascript
// Given a quality stub returning { qualityMult: 1.3, flags: [] }, when a cycle
// finalizes, repo.addSignal receives signal.plan.qualityMult === 1.3.
expect(savedSignal.plan.qualityMult).toBe(1.3);
// And with quality omitted, it defaults to 1.0:
expect(savedSignalNoQuality.plan.qualityMult).toBe(1.0);
```

(Use the existing emitter test's fake `repo` that captures `addSignal`'s argument.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- test/emit/emitter-quality.test.js`
Expected: FAIL (`qualityMult` undefined).

- [ ] **Step 3: Add `quality` to `createEmitter` + snapshot in `finalize`**

In the `createEmitter({ ... })` destructure (around line 47), add `quality = null,`.
In `finalize`, after the `entryPrice` block (around line 449) and before `repo.addSignal`, compute and attach the multiplier:

```javascript
    // Snapshot the quality multiplier at emit so the paper book is a reproducible,
    // quality-weighted fold over signals. Failure → neutral 1.0; never blocks the
    // hot path (same posture as the entryPrice fetch above).
    let qualityMult = 1.0;
    let qualityFlags = [];
    if (quality) {
      try {
        const q = await quality.getQuality(entry.symbol, entryPrice);
        qualityMult = q.qualityMult;
        qualityFlags = q.flags ?? [];
      } catch (err) {
        logger.error(`[emitter] quality fetch failed for ${entry.symbol}: ${err.message}`);
      }
    }
    signal = { ...signal, plan: { ...signal.plan, qualityMult, qualityFlags } };
```

- [ ] **Step 4: Inject the quality service** in `src/run/emitter.js`

```javascript
import { createQualityService } from '../quality/index.js';
// ...
const quality = createQualityService({ gunvest });
// add `quality,` to the createEmitter({ ... }) call
```

- [ ] **Step 5: Run the test + full suite**

Run: `npm test -- test/emit/emitter-quality.test.js` → PASS.
Run: `npm test` → PASS (existing emitter tests still green). Then `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/emit/emitter.js src/run/emitter.js test/emit/emitter-quality.test.js
git commit -m "feat: snapshot qualityMult onto signals at emit"
```

---

### Task 10: Live paper-book fold (pure)

**Files:**
- Create: `src/portfolio/paper-book.js`
- Test: `test/portfolio/paper-book.test.js` (create)

**Interfaces:**
- Consumes: `BAND_LONG` from `src/sizing/engine.js`; signals with `entryPrice` and `plan.qualityMult`.
- Produces: `buildPaperBook(signals, livePrices, { startingCapital, horizonDays, baseWeight, maxPerName })` → `{ curve, trades, openPositions, stats }`.
  - `signals`: oldest-first, each `{ symbol, band, conviction, plan, entry_price, spy_entry_price, qqq_entry_price, created_at, resolve_after }`.
  - `livePrices`: `{ [symbol]: number }` current marks (plus `SPY`, `QQQ`).
  - Entry fill at `signal.entry_price`; size `= clamp(baseWeight × conviction × qualityMult, 0, maxPerName) × equity`, capped at cash; no pyramiding. SELL/STRONG_SELL closes. Horizon exit when `now >= resolve_after`. Open positions marked at `livePrices`.

- [ ] **Step 1: Write the failing test** `test/portfolio/paper-book.test.js`

```javascript
import { describe, it, expect } from 'vitest';
import { buildPaperBook } from '../../src/portfolio/paper-book.js';

const sig = (o) => ({ band: 'BUY', conviction: 1, plan: { qualityMult: 1 }, spy_entry_price: 100, qqq_entry_price: 100, ...o });

describe('buildPaperBook', () => {
  it('enters at the captured entry_price, not a later close', () => {
    const signals = [sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T15:00:00Z', resolve_after: '2026-12-01T00:00:00Z' })];
    const { trades } = buildPaperBook(signals, { NVDA: 75, SPY: 110, QQQ: 110 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.1 });
    expect(trades[0].entryPrice).toBe(50);
  });

  it('weights the position by conviction × qualityMult', () => {
    const hi = buildPaperBook([sig({ symbol: 'A', entry_price: 10, plan: { qualityMult: 1.5 }, created_at: '2026-01-01T00:00:00Z', resolve_after: '2026-12-01T00:00:00Z' })], { A: 10, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    const lo = buildPaperBook([sig({ symbol: 'A', entry_price: 10, plan: { qualityMult: 0.5 }, created_at: '2026-01-01T00:00:00Z', resolve_after: '2026-12-01T00:00:00Z' })], { A: 10, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    expect(hi.trades[0].shares).toBeGreaterThan(lo.trades[0].shares);
  });

  it('marks an open position to the live price', () => {
    const { openPositions } = buildPaperBook([sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z', resolve_after: '2099-01-01T00:00:00Z' })], { NVDA: 75, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    expect(openPositions[0].markPrice).toBe(75);
    expect(openPositions[0].unrealizedReturn).toBeCloseTo(0.5, 5);
  });

  it('closes on a SELL signal', () => {
    const signals = [
      sig({ symbol: 'NVDA', entry_price: 50, created_at: '2026-01-01T00:00:00Z', resolve_after: '2099-01-01T00:00:00Z' }),
      sig({ symbol: 'NVDA', band: 'SELL', entry_price: 60, created_at: '2026-02-01T00:00:00Z', resolve_after: '2099-01-01T00:00:00Z' }),
    ];
    const { openPositions, trades } = buildPaperBook(signals, { NVDA: 75, SPY: 100, QQQ: 100 }, { startingCapital: 10000, horizonDays: 5, baseWeight: 0.05, maxPerName: 0.2 });
    expect(openPositions).toHaveLength(0);
    expect(trades[0].exitReason).toBe('sell-signal');
    expect(trades[0].exitPrice).toBe(60);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- test/portfolio/paper-book.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/portfolio/paper-book.js`**

```javascript
// Live, quality-weighted paper book. Replaces the deterministic close-replay sim.
// Fills at the emit-time price captured on each signal (signal.entry_price, ADR
// 0009) and sizes by conviction × the qualityMult snapshotted on the signal
// (signal.plan.qualityMult). Open positions are marked to the current live price.
// Pure: callers supply signals (oldest-first) and a live-price map.

import { BAND_LONG } from '../sizing/engine.js';

const SellBands = new Set(['SELL', 'STRONG_SELL']);

export function buildPaperBook(signals, livePrices, { startingCapital, horizonDays, baseWeight, maxPerName }) {
  const ordered = [...signals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let cash = startingCapital;
  const open = new Map(); // symbol → { entryPrice, shares, trade, resolveAfter }
  const trades = [];

  const equity = () => cash + [...open.values()].reduce((s, p) => s + p.shares * p.entryPrice, 0);

  const close = (symbol, price, reason) => {
    const pos = open.get(symbol);
    cash += pos.shares * price;
    Object.assign(pos.trade, { exitPrice: price, return: (price - pos.entryPrice) / pos.entryPrice, exitReason: reason });
    open.delete(symbol);
  };

  for (const s of ordered) {
    // Horizon exits for anything whose window closed before this signal's time.
    const nowTs = new Date(s.created_at).getTime();
    for (const [symbol, pos] of [...open]) {
      if (pos.resolveAfter && nowTs >= new Date(pos.resolveAfter).getTime()) {
        close(symbol, livePrices[symbol] ?? pos.entryPrice, 'horizon');
      }
    }
    if (SellBands.has(s.band)) {
      if (open.has(s.symbol)) close(s.symbol, s.entry_price ?? livePrices[s.symbol], 'sell-signal');
      continue;
    }
    const conviction = Number(s.conviction);
    if (!BAND_LONG.has(s.band) || conviction <= 0) continue;
    if (open.has(s.symbol)) continue; // no pyramiding
    const price = Number(s.entry_price);
    if (!price) continue;
    const qualityMult = Number(s.plan?.qualityMult ?? 1);
    const weight = Math.max(0, Math.min(baseWeight * conviction * qualityMult, maxPerName));
    const cost = Math.min(weight * equity(), cash);
    if (cost <= 0) continue;
    const shares = cost / price;
    cash -= cost;
    const trade = { symbol: s.symbol, band: s.band, conviction, qualityMult, entryDate: s.created_at, entryPrice: price, shares, exitPrice: null, return: null, exitReason: 'open' };
    trades.push(trade);
    open.set(s.symbol, { entryPrice: price, shares, trade, resolveAfter: s.resolve_after });
  }

  const openPositions = [...open.entries()].map(([symbol, pos]) => {
    const markPrice = livePrices[symbol] ?? pos.entryPrice;
    return { symbol, shares: pos.shares, entryPrice: pos.entryPrice, markPrice, marketValue: pos.shares * markPrice, unrealizedReturn: (markPrice - pos.entryPrice) / pos.entryPrice };
  });

  const markedEquity = cash + openPositions.reduce((s, p) => s + p.marketValue, 0);
  const closed = trades.filter((t) => t.exitReason !== 'open');
  const stats = {
    totalReturn: markedEquity / startingCapital - 1,
    openValue: openPositions.reduce((s, p) => s + p.marketValue, 0),
    cash,
    trades: trades.length,
    winRate: closed.length ? closed.filter((t) => t.return > 0).length / closed.length : 0,
  };
  // Single live data point; the historical curve is rebuilt by the route from
  // benchmark entry prices (Task 11). Here we expose the marked equity for now.
  const curve = [{ date: 'live', equity: markedEquity }];
  return { curve, trades, openPositions, stats };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/portfolio/paper-book.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/portfolio/paper-book.js test/portfolio/paper-book.test.js
git commit -m "feat: add live quality-weighted paper-book fold"
```

---

### Task 11: Rework the portfolio route to serve the paper book

**Files:**
- Modify: `src/api/routes/portfolio.js` (replace `simulatePortfolio` usage with `buildPaperBook`)
- Test: `test/api/portfolio.test.js` (update expectations)

**Interfaces:**
- Consumes: `repo.listAllSignals` (now returns `plan` with `qualityMult`; ensure it also selects `entry_price`, `spy_entry_price`, `qqq_entry_price`, `resolve_after` — extend the SELECT in `listAllSignals` if those columns aren't already returned), `gunvest.getPrice` for live marks of held symbols + SPY + QQQ.
- Produces: `GET /api/portfolio` → `{ curve, trades, openPositions, stats }` from `buildPaperBook`, filtered to the user's watchlist (as today).

- [ ] **Step 1: Extend `repo.listAllSignals` SELECT** (if needed)

Confirm with: `grep -n "listAllSignals" -A6 src/db/repo.js`. Ensure the SELECT returns `entry_price, spy_entry_price, qqq_entry_price, resolve_after` in addition to the current columns. Update the column list if missing.

- [ ] **Step 2: Update the failing test** `test/api/portfolio.test.js`

Replace the deterministic-sim expectations with paper-book ones: given signals carrying `entry_price` + `plan.qualityMult` and a `gunvest.getPrice` stub, assert the response has `openPositions` and `stats.totalReturn`, and that an open position is marked at the live price. (Mirror the existing test's app/repo/gunvest fakes; only the assertions and the repo `listAllSignals` rows change.)

```javascript
// signals: one open BUY for NVDA entry_price 50, resolve_after far future
// gunvest.getPrice('NVDA') → { price: 75 }
const res = await request(app).get('/api/portfolio');
expect(res.body.openPositions[0].symbol).toBe('NVDA');
expect(res.body.openPositions[0].markPrice).toBe(75);
expect(res.body.stats.totalReturn).toBeGreaterThan(0);
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npm test -- test/api/portfolio.test.js`
Expected: FAIL.

- [ ] **Step 4: Rewrite the route body** in `src/api/routes/portfolio.js`

```javascript
import { Router } from 'express';
import { buildPaperBook } from '../../portfolio/paper-book.js';

const DefaultStartingCash = 100000;
const BaseWeight = 0.05;
const MaxPerName = 0.10;
const CacheTtlMs = 30 * 1000; // live marks refresh ~ client poll cadence

export function portfolioRoutes(repo, gunvest, { horizonDays = 5 } = {}) {
  const router = Router();
  const cache = new Map(); // userId -> { at, key, payload }

  router.get('/', async (req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      const userId = req.user.id;
      const [watchlist, config] = await Promise.all([
        repo.listWatchlist(userId),
        repo.getPortfolioConfig(userId),
      ]);
      const startingCapital = config?.startingCash ?? DefaultStartingCash;
      const userHorizon = config?.horizonDays ?? horizonDays;

      const watchSet = new Set(watchlist);
      const signals = (await repo.listAllSignals()).filter((s) => watchSet.has(s.symbol));
      const symbols = [...new Set(signals.map((s) => s.symbol))];

      const key = JSON.stringify({ w: watchlist, c: startingCapital, h: userHorizon, n: signals.length });
      const hit = cache.get(userId);
      if (hit && hit.key === key && Date.now() - hit.at < CacheTtlMs) return res.json(hit.payload);

      const livePrices = {};
      await Promise.all([...symbols, 'SPY', 'QQQ'].map(async (sym) => {
        const p = await gunvest.getPrice(sym).catch(() => null);
        if (p?.price != null) livePrices[sym] = p.price;
      }));

      const payload = buildPaperBook(signals, livePrices, {
        startingCapital, horizonDays: userHorizon, baseWeight: BaseWeight, maxPerName: MaxPerName,
      });
      cache.set(userId, { at: Date.now(), key, payload });
      res.json(payload);
    } catch (err) { next(err); }
  });

  return router;
}
```

- [ ] **Step 5: Run the test + full suite**

Run: `npm test -- test/api/portfolio.test.js` → PASS.
Run: `npm test` → PASS. Then `npm run lint`.

- [ ] **Step 6: Delete the obsolete deterministic sim**

Remove `src/portfolio/simulate.js` and `test/portfolio/simulate.test.js` (replaced by the paper book). Verify nothing else imports `simulatePortfolio`:

Run: `grep -rn "simulatePortfolio" src test` → expect no matches after deletion.

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/portfolio.js test/api/portfolio.test.js src/db/repo.js
git rm src/portfolio/simulate.js test/portfolio/simulate.test.js
git commit -m "feat: replace deterministic sim with live quality-weighted paper book"
```

---

### Task 12: Web — update the Portfolio page for the live paper book

**Files:**
- Modify: `web/src/pages/PortfolioPage.jsx` (render `openPositions` + live stats; the equity curve is now a single live point, so swap the chart for an open-positions table or keep a sparkline of `curve` if multiple points exist)
- Test: `web/test/pages/PortfolioPage.test.jsx` (update expectations)

**Interfaces:**
- Consumes: `GET /api/portfolio` → `{ curve, trades, openPositions, stats }`.
- Produces: a Portfolio page showing live total return, open value, cash, and an open-positions table (symbol, shares, entry → mark, unrealized return) plus the trade log; polls every 20s.

- [ ] **Step 1: Update the failing test** `web/test/pages/PortfolioPage.test.jsx`

Mock `api.getPortfolio` to resolve `{ curve: [{date:'live',equity:10500}], trades: [], openPositions: [{ symbol:'NVDA', shares:2, entryPrice:50, markPrice:75, unrealizedReturn:0.5 }], stats: { totalReturn:0.05, openValue:150, cash:9850, trades:1, winRate:0 } }`. Assert `NVDA` and the open value render.

- [ ] **Step 2: Run it, verify it fails**

Run: `cd web && npm test -- test/pages/PortfolioPage.test.jsx`
Expected: FAIL.

- [ ] **Step 3: Update `PortfolioPage.jsx`**

Replace the stats grid to use `stats.totalReturn`, `stats.openValue`, `stats.cash`, `stats.trades`, `stats.winRate`. Add a 20s poll (`setInterval(() => api.getPortfolio().then(setData), 20000)` in the effect, cleared on unmount). Add an open-positions table:

```jsx
<Card className="mb-5 overflow-hidden">
  <table className="w-full text-left text-sm">
    <thead><tr className="border-b border-slate-200">
      {['Symbol','Shares','Entry → Mark','Unrealized'].map((h)=>(<th key={h} className="px-4 py-2 font-medium text-slate-500">{h}</th>))}
    </tr></thead>
    <tbody>
      {data.openPositions.map((p)=>(
        <tr key={p.symbol} className="border-b border-slate-100 last:border-0">
          <td className="px-4 py-2 font-medium">{p.symbol}</td>
          <td className="px-4 py-2">{p.shares.toFixed(2)}</td>
          <td className="px-4 py-2">{`$${p.entryPrice.toFixed(2)} → $${p.markPrice.toFixed(2)}`}</td>
          <td className={`px-4 py-2 ${p.unrealizedReturn>=0?'text-green-600':'text-red-600'}`}>{signedPct(p.unrealizedReturn)}</td>
        </tr>
      ))}
    </tbody>
  </table>
</Card>
```

Keep the existing trades table. Guard the early-return: replace `data.curve.length === 0` empty-state with `data.openPositions.length === 0 && data.trades.length === 0`.

- [ ] **Step 4: Run the web test + lint**

Run: `cd web && npm test -- test/pages/PortfolioPage.test.jsx` → PASS.
Run: `cd web && npm run lint` and root `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/PortfolioPage.jsx web/test/pages/PortfolioPage.test.jsx
git commit -m "feat: render live paper book with open positions"
```

---

## Final verification

- [ ] **Run the full backend suite:** `npm test` → all PASS.
- [ ] **Run the web suite:** `cd web && npm test` → all PASS.
- [ ] **Lint:** `npm run lint` (and web lint) → clean.
- [ ] **Migrate locally:** `npm run db:migrate` applies `legion.holdings` without error.
- [ ] **Manual smoke (optional):** add a holding via the UI, confirm the sizing table renders a buy/trim with a live price.

---

## Self-Review

**Spec coverage:**
- Holdings store (manual, real user_id, gunvest column shape) → Task 1. ✓
- Data feeds via gunvest REST (price already wired; `getFundamentals`; analyst gap noted) → Task 2 (+ cross-repo note). ✓
- Quality scoring (4 sub-scores, [0.5,1.5], degradation) → Task 3; moat LLM → Task 4; fetch+cache → Task 5. ✓
- Sizing engine (pure, clamp, BUY/SELL/NO_CONSENSUS, deltas, P/L, flags) → Task 6. ✓
- Live paper book replacing deterministic sim (fill at entry_price, quality-weighted, live mark, exits) → Tasks 9–11. ✓
- qualityMult snapshot on signal at emit, neutral fallback, hot path non-blocking → Task 9. ✓
- API: `/api/holdings` CRUD + `/sizing`, reworked `/api/portfolio` → Tasks 7, 11. ✓
- Web: holdings page + paper-book page, 20s poll → Tasks 8, 12. ✓
- Error handling (neutral degradation, stale price, no-signal trim) → Tasks 3, 6, 9. ✓
- Reuse audit (no axios/crumb in legion; port math not deps) → honored throughout. ✓

**Placeholder scan:** No TBD/TODO; pure-module steps carry full code. UI/emitter wiring steps point to exact files with a grep to confirm the one pattern detail (router registration, provider method name, api client helper names) that varies by repo state — these are verification steps, not placeholders.

**Type consistency:** `qualityMult`, `subScores`, `flags` consistent across Tasks 3/5/6/9. `computeSizing`/`buildSizingBook` row shape matches the route (Task 7) and web table (Task 8). `buildPaperBook` output (`curve/trades/openPositions/stats`) matches the route (Task 11) and web page (Task 12). `signal.plan.qualityMult` written in Task 9 is read in Tasks 6-data (via route) and 10.

**Open cross-repo dependency:** analyst sub-score needs a small gunvest-side add (Task 2 note); until shipped it degrades to neutral — not a blocker.
