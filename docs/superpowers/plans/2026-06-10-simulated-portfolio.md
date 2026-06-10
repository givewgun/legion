# Simulated Portfolio Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A web page that replays Legion's emitted signals as a paper portfolio and compares its equity curve against SPY/QQQ buy-and-hold.

**Architecture:** Pure simulation engine (`src/portfolio/simulate.js`, no I/O — same pattern as `src/backtest/deterministic.js`), an on-demand `GET /api/portfolio` route with a 10-minute in-memory cache that pulls candles from gunvest, and a React page with a recharts LineChart + stat cards + trades table.

**Tech Stack:** Node ES modules, Express, vitest + supertest (backend), React + recharts + Tailwind, vitest + testing-library (web).

**Spec:** `docs/superpowers/specs/2026-06-10-simulated-portfolio-design.md`

**Branch:** `claude/simulated-portfolio` (already created; spec committed on it)

**Key domain facts** (engineer needs zero codebase context):

- Signals live in Postgres `legion.signals`: `{ id, symbol, band, conviction, plan, created_at }`. `band` ∈ STRONG_SELL | SELL | HOLD | BUY | STRONG_BUY | NO_CONSENSUS. `conviction` ∈ 0–1 (Postgres NUMERIC → arrives as a string; always `Number()` it). `plan` JSONB has **no** entry/stop/target/size fields.
- `gunvest.getCandles(symbol, days)` returns daily candles `[{ date: 'yyyy-mm-dd', close: number }]`, oldest first.
- `horizonDays` (config, default 5) is the trading-day window the reliability resolver scores signals against — the simulation uses the same window for auto-exit.
- Backend tests run with `npx vitest run <path>` from the repo root. Web tests run with `npx vitest run <path>` from `web/`.
- Pre-commit hooks run lint-staged/ESLint — never bypass them.

---

### Task 1: Simulation engine

**Files:**
- Create: `src/portfolio/simulate.js`
- Test: `test/portfolio/simulate.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/portfolio/simulate.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { simulatePortfolio } from '../../src/portfolio/simulate.js';

// Fixture helpers: a synthetic trading calendar of consecutive January days.
const day = (n) => `2026-01-${String(n).padStart(2, '0')}`;
const series = (closes) => closes.map((close, i) => ({ date: day(i + 1), close }));
const flat = (price, n) => series(Array(n).fill(price));

const signal = (symbol, band, dayN, conviction = 1) => ({
  symbol,
  band,
  conviction: String(conviction), // NUMERIC arrives as a string from pg
  created_at: `${day(dayN)}T14:30:00Z`,
});

describe('simulatePortfolio', () => {
  it('opens a conviction-sized long and exits after horizonDays trading days', () => {
    const nvda = series([100, 100, 100, 100, 100, 110, 110, 110, 110, 110]);
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1, 1)],
      { NVDA: nvda },
      flat(100, 10),
      flat(100, 10),
    );
    // 10% of 100k = 10k at $100 → 100 shares; horizon exit on day 6 at $110.
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.shares).toBeCloseTo(100);
    expect(t.entryDate).toBe(day(1));
    expect(t.exitDate).toBe(day(6));
    expect(t.exitPrice).toBe(110);
    expect(t.return).toBeCloseTo(0.1);
    expect(t.exitReason).toBe('horizon');
    expect(r.stats.totalReturn).toBeCloseTo(0.01);
    expect(r.stats.winRate).toBe(1);
  });

  it('closes early on a SELL signal for the same symbol', () => {
    const nvda = series([100, 100, 105, 105, 105, 105, 105, 105, 105, 105]);
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1), signal('NVDA', 'SELL', 3)],
      { NVDA: nvda },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitDate).toBe(day(3));
    expect(r.trades[0].exitReason).toBe('sell-signal');
    expect(r.trades[0].return).toBeCloseTo(0.05);
  });

  it('does not pyramid an already-open symbol', () => {
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1), signal('NVDA', 'STRONG_BUY', 2)],
      { NVDA: flat(100, 10) },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(1);
  });

  it('caps a position at available cash', () => {
    // maxPositionFraction 1 + conviction 1 → first buy consumes all cash; the
    // second symbol has nothing left to buy with.
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1), signal('MSFT', 'BUY', 1)],
      { NVDA: flat(100, 10), MSFT: flat(50, 10) },
      flat(100, 10),
      flat(100, 10),
      { maxPositionFraction: 1 },
    );
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].symbol).toBe('NVDA');
  });

  it('ignores HOLD, NO_CONSENSUS, and zero-conviction signals', () => {
    const r = simulatePortfolio(
      [
        signal('NVDA', 'HOLD', 1),
        signal('NVDA', 'NO_CONSENSUS', 2, 0),
        signal('NVDA', 'BUY', 3, 0),
      ],
      { NVDA: flat(100, 10) },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(0);
    // The curve still starts at the first signal's day (flat cash).
    expect(r.curve[0]).toMatchObject({ date: day(1), equity: 100_000 });
  });

  it('counts a buy with no candle data as skipped', () => {
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1)],
      { NVDA: [] },
      flat(100, 10),
      flat(100, 10),
    );
    expect(r.trades).toHaveLength(0);
    expect(r.stats.skipped).toBe(1);
  });

  it('tracks SPY and QQQ buy-and-hold benchmarks from the first signal day', () => {
    const r = simulatePortfolio(
      [signal('NVDA', 'HOLD', 1)],
      { NVDA: flat(100, 3) },
      series([100, 105, 110]),
      series([200, 220, 240]),
    );
    expect(r.curve.map((p) => p.spy)).toEqual([100_000, 105_000, 110_000]);
    expect(r.curve.map((p) => p.qqq)).toEqual([100_000, 110_000, 120_000]);
    expect(r.stats.spyReturn).toBeCloseTo(0.1);
    expect(r.stats.qqqReturn).toBeCloseTo(0.2);
  });

  it('returns empty results for no signals', () => {
    const r = simulatePortfolio([], {}, flat(100, 10), flat(100, 10));
    expect(r.curve).toEqual([]);
    expect(r.trades).toEqual([]);
    expect(r.stats.totalReturn).toBe(0);
    expect(r.stats.trades).toBe(0);
  });

  it('leaves a position open at the end of the calendar with unrealized return', () => {
    const nvda = series([100, 120, 90]);
    const r = simulatePortfolio(
      [signal('NVDA', 'BUY', 1)],
      { NVDA: nvda },
      flat(100, 3),
      flat(100, 3),
      { maxPositionFraction: 1 },
    );
    expect(r.trades[0].exitReason).toBe('open');
    expect(r.trades[0].exitDate).toBeNull();
    expect(r.trades[0].return).toBeCloseTo(-0.1);
    // Equity 100k → 120k → 90k: max drawdown (120k-90k)/120k = 0.25.
    expect(r.stats.maxDrawdown).toBeCloseTo(0.25);
    // Open trades don't count toward win rate.
    expect(r.stats.winRate).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from repo root: `npx vitest run test/portfolio/simulate.test.js`
Expected: FAIL — `Cannot find module .../src/portfolio/simulate.js` (or equivalent ESM resolve error).

- [ ] **Step 3: Implement the engine**

Create `src/portfolio/simulate.js`:

```js
// Replays Legion's emitted signals as a paper, long-only portfolio and marks it
// to market daily against SPY / QQQ buy-and-hold benchmarks. Pure function —
// callers supply signals and candles; no I/O here (same pattern as
// backtest/deterministic.js).
//
// Trade rules (docs/superpowers/specs/2026-06-10-simulated-portfolio-design.md):
// - BUY/STRONG_BUY opens a long sized conviction × maxPositionFraction × equity,
//   capped at available cash. No pyramiding: a symbol already held is skipped.
// - SELL/STRONG_SELL closes any open position in that symbol. No shorts.
// - HOLD / NO_CONSENSUS / zero conviction are ignored.
// - Positions auto-close horizonDays *trading days* after entry — the same
//   window the reliability resolver scores signals against.

const DefaultStartingCapital = 100_000;
const DefaultHorizonDays = 5;
// Fraction of current equity a full-conviction position takes.
const DefaultMaxPositionFraction = 0.1;

const BuyBands = new Set(['BUY', 'STRONG_BUY']);
const SellBands = new Set(['SELL', 'STRONG_SELL']);

// Calendar day (yyyy-mm-dd, UTC) of a signal timestamp, for alignment with
// daily candle dates.
function dayOf(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function simulatePortfolio(signals, candlesBySymbol, spy, qqq, opts = {}) {
  const {
    startingCapital = DefaultStartingCapital,
    horizonDays = DefaultHorizonDays,
    maxPositionFraction = DefaultMaxPositionFraction,
  } = opts;

  // SPY's dates are the trading calendar; per-symbol closes are keyed by date.
  const calendar = spy.map((c) => c.date);
  const closesBySymbol = new Map(
    Object.entries(candlesBySymbol).map(([symbol, candles]) => [
      symbol,
      new Map(candles.map((c) => [c.date, c.close])),
    ]),
  );
  const spyCloses = new Map(spy.map((c) => [c.date, c.close]));
  const qqqCloses = new Map(qqq.map((c) => [c.date, c.close]));
  const priceOn = (symbol, date) => closesBySymbol.get(symbol)?.get(date);

  // Group signals by the first trading day on/after their emission day.
  let skipped = 0;
  const signalsByDay = new Map();
  const ordered = [...signals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const sig of ordered) {
    const day = calendar.find((d) => d >= dayOf(sig.created_at));
    if (!day) {
      skipped += 1; // emitted after the last candle — nothing to trade against
      continue;
    }
    if (!signalsByDay.has(day)) signalsByDay.set(day, []);
    signalsByDay.get(day).push(sig);
  }

  const curve = [];
  const trades = [];
  const tradeDays = [...signalsByDay.keys()].sort();
  if (tradeDays.length === 0) {
    return { curve, trades, stats: buildStats(curve, trades, startingCapital, skipped) };
  }

  const startIdx = calendar.indexOf(tradeDays[0]);
  const spyStart = spyCloses.get(calendar[startIdx]);
  let lastQqqClose = qqqCloses.get(calendar[startIdx]);
  const qqqStart = lastQqqClose;

  let cash = startingCapital;
  const open = new Map(); // symbol → { entryIdx, entryPrice, shares, lastPrice, trade }

  function markedEquity(date) {
    let value = cash;
    for (const [symbol, pos] of open) {
      value += pos.shares * (priceOn(symbol, date) ?? pos.lastPrice);
    }
    return value;
  }

  function closePosition(symbol, date, exitReason) {
    const pos = open.get(symbol);
    const price = priceOn(symbol, date) ?? pos.lastPrice;
    cash += pos.shares * price;
    Object.assign(pos.trade, {
      exitDate: date,
      exitPrice: price,
      return: (price - pos.entryPrice) / pos.entryPrice,
      exitReason,
    });
    open.delete(symbol);
  }

  for (let i = startIdx; i < calendar.length; i += 1) {
    const date = calendar[i];

    // 1. Horizon exits.
    for (const [symbol, pos] of [...open]) {
      if (i - pos.entryIdx >= horizonDays) closePosition(symbol, date, 'horizon');
    }

    // 2. Today's signals: sells close, buys open.
    for (const sig of signalsByDay.get(date) ?? []) {
      const conviction = Number(sig.conviction);
      if (SellBands.has(sig.band)) {
        if (open.has(sig.symbol)) closePosition(sig.symbol, date, 'sell-signal');
        continue;
      }
      if (!BuyBands.has(sig.band) || conviction <= 0) continue;
      if (open.has(sig.symbol)) continue; // no pyramiding
      const price = priceOn(sig.symbol, date);
      if (!price) {
        skipped += 1;
        continue;
      }
      const cost = Math.min(conviction * maxPositionFraction * markedEquity(date), cash);
      if (cost <= 0) continue;
      const shares = cost / price;
      cash -= cost;
      const trade = {
        symbol: sig.symbol,
        band: sig.band,
        conviction,
        entryDate: date,
        entryPrice: price,
        shares,
        exitDate: null,
        exitPrice: null,
        return: null,
        exitReason: 'open',
      };
      trades.push(trade);
      open.set(sig.symbol, { entryIdx: i, entryPrice: price, shares, lastPrice: price, trade });
    }

    // 3. Mark to market (carry the last known price across missing candles).
    for (const [symbol, pos] of open) {
      const price = priceOn(symbol, date);
      if (price) pos.lastPrice = price;
    }
    const qqqClose = qqqCloses.get(date);
    if (qqqClose) lastQqqClose = qqqClose;
    curve.push({
      date,
      equity: markedEquity(date),
      spy: (startingCapital * spyCloses.get(date)) / spyStart,
      qqq: qqqStart ? (startingCapital * lastQqqClose) / qqqStart : startingCapital,
    });
  }

  // Unrealized return on positions still open at the end of the calendar.
  for (const pos of open.values()) {
    pos.trade.return = (pos.lastPrice - pos.entryPrice) / pos.entryPrice;
  }

  return { curve, trades, stats: buildStats(curve, trades, startingCapital, skipped) };
}

function buildStats(curve, trades, startingCapital, skipped) {
  const last = curve.at(-1);
  const closed = trades.filter((t) => t.exitReason !== 'open');
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
  }
  return {
    totalReturn: last ? last.equity / startingCapital - 1 : 0,
    spyReturn: last ? last.spy / startingCapital - 1 : 0,
    qqqReturn: last ? last.qqq / startingCapital - 1 : 0,
    maxDrawdown,
    winRate: closed.length ? closed.filter((t) => t.return > 0).length / closed.length : 0,
    trades: trades.length,
    skipped,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/portfolio/simulate.test.js`
Expected: 9 tests PASS.

- [ ] **Step 5: Run lint and the full backend suite**

Run: `npm run lint && npm test`
Expected: lint clean, all tests pass (the suite has 300+ existing tests — none should break; this task adds files only).

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/simulate.js test/portfolio/simulate.test.js
git commit -m "feat: add signal-replay portfolio simulation engine"
```

---

### Task 2: `listAllSignals` repo method

**Files:**
- Modify: `src/db/repo.js` (insert directly after the existing `listSignals` method, ~line 537)
- Test: `test/db/repo.read.test.js` (append inside the existing `describe('repo read + config methods')` block; reuse its local `poolReturning` helper)

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `test/db/repo.read.test.js`:

```js
  it('lists all signals oldest-first for the portfolio simulation', async () => {
    const pool = poolReturning([[{ id: 1, symbol: 'NVDA', band: 'BUY' }]]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listAllSignals();
    expect(rows).toEqual([{ id: 1, symbol: 'NVDA', band: 'BUY' }]);
    expect(pool.calls[0].text).toMatch(/FROM legion\.signals/);
    expect(pool.calls[0].text).toMatch(/ORDER BY created_at ASC/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo.read.test.js`
Expected: FAIL — `repo.listAllSignals is not a function`.

- [ ] **Step 3: Implement**

In `src/db/repo.js`, directly after the closing `},` of the `listSignals` method, add:

```js
    // Every emitted signal, oldest-first, for the portfolio replay simulation.
    async listAllSignals() {
      const rows = await db.query(
        `SELECT id, symbol, band, conviction, plan, created_at
           FROM legion.signals ORDER BY created_at ASC`,
      );
      return rows;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/db/repo.read.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js test/db/repo.read.test.js
git commit -m "feat: add listAllSignals repo method for portfolio replay"
```

---

### Task 3: `GET /api/portfolio` route + wiring

**Files:**
- Create: `src/api/routes/portfolio.js`
- Modify: `src/api/app.js` (add import + mount + `gunvest`/`horizonDays` params)
- Modify: `src/run/api.js` (construct gunvest, pass through)
- Test: `test/api/portfolio.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/api/portfolio.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

const day = (n) => `2026-01-${String(n).padStart(2, '0')}`;
const flat = (price, n) =>
  Array.from({ length: n }, (_, i) => ({ date: day(i + 1), close: price }));

function fixtures() {
  const repo = {
    listAllSignals: vi.fn(async () => [
      {
        id: 1,
        symbol: 'NVDA',
        band: 'BUY',
        conviction: '1.0',
        plan: {},
        created_at: `${day(1)}T14:30:00Z`,
      },
    ]),
  };
  const gunvest = { getCandles: vi.fn(async () => flat(100, 9)) };
  return { repo, gunvest };
}

describe('GET /api/portfolio', () => {
  it('replays signals into a portfolio payload', async () => {
    const { repo, gunvest } = fixtures();
    const res = await request(createApp({ repo, gunvest })).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.stats.trades).toBe(1);
    expect(res.body.curve).toHaveLength(9);
    expect(res.body.trades[0].symbol).toBe('NVDA');
  });

  it('caches the payload between requests', async () => {
    const { repo, gunvest } = fixtures();
    const app = createApp({ repo, gunvest });
    await request(app).get('/api/portfolio');
    await request(app).get('/api/portfolio');
    expect(repo.listAllSignals).toHaveBeenCalledTimes(1);
  });

  it('returns 503 without a gunvest client', async () => {
    const { repo } = fixtures();
    const res = await request(createApp({ repo })).get('/api/portfolio');
    expect(res.status).toBe(503);
  });

  it('skips a symbol whose candle fetch fails', async () => {
    const { repo, gunvest } = fixtures();
    gunvest.getCandles = vi.fn(async (symbol) => {
      if (symbol === 'NVDA') throw new Error('boom');
      return flat(100, 9);
    });
    const res = await request(createApp({ repo, gunvest })).get('/api/portfolio');
    expect(res.status).toBe(200);
    expect(res.body.stats.skipped).toBe(1);
    expect(res.body.stats.trades).toBe(0);
  });

  it('fails the request when a benchmark fetch fails', async () => {
    const { repo, gunvest } = fixtures();
    gunvest.getCandles = vi.fn(async (symbol) => {
      if (symbol === 'SPY') throw new Error('boom');
      return flat(100, 9);
    });
    const res = await request(createApp({ repo, gunvest })).get('/api/portfolio');
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/portfolio.test.js`
Expected: FAIL — 404s (route not mounted) / module not found.

- [ ] **Step 3: Implement the route**

Create `src/api/routes/portfolio.js`:

```js
import { Router } from 'express';
import { simulatePortfolio } from '../../portfolio/simulate.js';

// Same candle depth as run/backtest.js — enough history to cover every signal.
const FetchDays = 400;
// Signals change at most once per cycle; candle fetches are the slow part.
const CacheTtlMs = 10 * 60 * 1000;

export function portfolioRoutes(repo, gunvest, { horizonDays = 5 } = {}) {
  const router = Router();
  let cache = null; // { at, payload }

  // `_req` (not `req`): the handler takes no query params and ESLint errors on
  // unused args unless they are underscore-prefixed.
  router.get('/', async (_req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      if (cache && Date.now() - cache.at < CacheTtlMs) return res.json(cache.payload);

      const signals = await repo.listAllSignals();
      const symbols = [...new Set(signals.map((s) => s.symbol))];
      // Benchmark failures fail the whole request; a single symbol's failure
      // only skips that symbol's trades (the sim counts them as skipped).
      const [spy, qqq] = await Promise.all([
        gunvest.getCandles('SPY', FetchDays),
        gunvest.getCandles('QQQ', FetchDays),
      ]);
      const candlesBySymbol = {};
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            candlesBySymbol[symbol] = await gunvest.getCandles(symbol, FetchDays);
          } catch (err) {
            console.warn(`[portfolio] candles for ${symbol} unavailable: ${err.message}`);
            candlesBySymbol[symbol] = [];
          }
        }),
      );

      const payload = simulatePortfolio(signals, candlesBySymbol, spy, qqq, { horizonDays });
      cache = { at: Date.now(), payload };
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Wire into the app**

In `src/api/app.js`:

Add the import alongside the other route imports:

```js
import { portfolioRoutes } from './routes/portfolio.js';
```

Change the `createApp` signature line from:

```js
export function createApp({ repo, orchestrator = null }) {
```

to:

```js
export function createApp({ repo, orchestrator = null, gunvest = null, horizonDays = 5 }) {
```

Add the mount alongside the other `app.use('/api/...')` lines:

```js
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, { horizonDays }));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api/portfolio.test.js`
Expected: 5 tests PASS.

- [ ] **Step 6: Wire gunvest into the API entrypoint**

In `src/run/api.js`:

Add the import alongside the others:

```js
import { createGunvestFromConfig } from '../data/gunvest.js';
```

Change the last two lines from:

```js
const app = createApp({ repo, orchestrator });
app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
```

to:

```js
const gunvest = createGunvestFromConfig(cfg);
const app = createApp({ repo, orchestrator, gunvest, horizonDays: cfg.horizonDays });
app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
```

(`cfg.horizonDays` and `cfg.gunvest` already exist in `src/config/index.js` — no config changes needed.)

- [ ] **Step 7: Run lint and the full backend suite**

Run: `npm run lint && npm test`
Expected: lint clean, all backend tests pass (existing `createApp` callers pass no `gunvest`, which defaults to `null` → existing tests unaffected; the new route just 503s for them).

- [ ] **Step 8: Commit**

```bash
git add src/api/routes/portfolio.js src/api/app.js src/run/api.js test/api/portfolio.test.js
git commit -m "feat: add GET /api/portfolio signal-replay endpoint"
```

---

### Task 4: Web page

**Files:**
- Modify: `web/src/api/client.js` (add `getPortfolio`)
- Create: `web/src/pages/PortfolioPage.jsx`
- Modify: `web/src/App.jsx` (route)
- Modify: `web/src/ui/NavBar.jsx` (nav link)
- Modify: `web/test/App.test.jsx` (stub + nav test)
- Test: `web/test/pages/PortfolioPage.test.jsx`

All commands in this task run from the `web/` directory.

- [ ] **Step 1: Write the failing page tests**

Create `web/test/pages/PortfolioPage.test.jsx`:

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PortfolioPage } from '../../src/pages/PortfolioPage.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => vi.restoreAllMocks());

const payload = {
  curve: [
    { date: '2026-01-01', equity: 100000, spy: 100000, qqq: 100000 },
    { date: '2026-01-02', equity: 101000, spy: 100500, qqq: 100200 },
  ],
  trades: [
    {
      symbol: 'NVDA',
      band: 'BUY',
      conviction: 0.8,
      entryDate: '2026-01-01',
      entryPrice: 100,
      shares: 80,
      exitDate: '2026-01-02',
      exitPrice: 110,
      return: 0.1,
      exitReason: 'horizon',
    },
  ],
  stats: {
    totalReturn: 0.01,
    spyReturn: 0.005,
    qqqReturn: 0.002,
    maxDrawdown: 0.02,
    winRate: 1,
    trades: 1,
    skipped: 0,
  },
};

describe('PortfolioPage', () => {
  it('renders stats, the chart, and the trades table', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue(payload);
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByTestId('portfolio-chart')).toBeInTheDocument();
    expect(screen.getByText(/Total return/i)).toBeInTheDocument();
    expect(screen.getByText('horizon')).toBeInTheDocument();
  });

  it('shows an empty state when there is nothing to simulate', async () => {
    vi.spyOn(api, 'getPortfolio').mockResolvedValue({ curve: [], trades: [], stats: {} });
    render(<PortfolioPage />);
    await waitFor(() =>
      expect(screen.getByText(/No signals to simulate yet/i)).toBeInTheDocument(),
    );
  });

  it('shows an error state', async () => {
    vi.spyOn(api, 'getPortfolio').mockRejectedValue(new Error('boom'));
    render(<PortfolioPage />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `web/`): `npx vitest run test/pages/PortfolioPage.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the API client method**

In `web/src/api/client.js`, add to the `api` object (after `getBacktest`):

```js
  getPortfolio: () => get('/api/portfolio'),
```

- [ ] **Step 4: Create the page**

Create `web/src/pages/PortfolioPage.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { api } from '../api/client.js';
import { pct, bandColor } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

const money = (v) => `$${Math.round(v ?? 0).toLocaleString('en-US')}`;
const signedPct = (v) => `${v > 0 ? '+' : ''}${pct(v)}`;
const gainColor = (v) => (v >= 0 ? 'text-green-600' : 'text-red-600');

function Stat({ label, value, accent = '' }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${accent}`}>{value}</p>
    </Card>
  );
}

export function PortfolioPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getPortfolio()
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-slate-400">Simulating portfolio…</p>;
  if (data.curve.length === 0)
    return <p className="text-slate-400">No signals to simulate yet.</p>;

  const { curve, trades, stats } = data;

  return (
    <div>
      <PageHeader
        title="Portfolio"
        subtitle="Paper portfolio replaying every emitted signal vs SPY / QQQ buy-and-hold"
      />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Total return"
          value={signedPct(stats.totalReturn)}
          accent={gainColor(stats.totalReturn)}
        />
        <Stat
          label="vs SPY"
          value={signedPct(stats.totalReturn - stats.spyReturn)}
          accent={gainColor(stats.totalReturn - stats.spyReturn)}
        />
        <Stat
          label="vs QQQ"
          value={signedPct(stats.totalReturn - stats.qqqReturn)}
          accent={gainColor(stats.totalReturn - stats.qqqReturn)}
        />
        <Stat label="Max drawdown" value={pct(stats.maxDrawdown)} />
        <Stat label="Win rate" value={pct(stats.winRate)} />
        <Stat label="Trades" value={stats.trades} />
      </div>
      <Card className="mb-5 p-3">
        <div className="h-72 w-full" data-testid="portfolio-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={curve} margin={{ left: 8, right: 8 }}>
              <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} />
              <YAxis
                tickFormatter={money}
                stroke="#94a3b8"
                fontSize={12}
                width={80}
                domain={['auto', 'auto']}
              />
              <Tooltip formatter={(v) => money(v)} />
              <Legend />
              <Line type="monotone" dataKey="equity" name="Portfolio" stroke="#4f46e5" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="spy" name="SPY" stroke="#94a3b8" dot={false} />
              <Line type="monotone" dataKey="qqq" name="QQQ" stroke="#cbd5e1" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Symbol</th>
              <th className="px-4 py-2 font-medium text-slate-500">Band</th>
              <th className="px-4 py-2 font-medium text-slate-500">Conviction</th>
              <th className="px-4 py-2 font-medium text-slate-500">Entry</th>
              <th className="px-4 py-2 font-medium text-slate-500">Exit</th>
              <th className="px-4 py-2 font-medium text-slate-500">Return</th>
              <th className="px-4 py-2 font-medium text-slate-500">Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={`${t.symbol}-${t.entryDate}-${i}`} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{t.symbol}</td>
                <td className={`px-4 py-2 ${bandColor(t.band)}`}>{t.band}</td>
                <td className="px-4 py-2">{pct(t.conviction)}</td>
                <td className="px-4 py-2">{`${t.entryDate} @ $${t.entryPrice.toFixed(2)}`}</td>
                <td className="px-4 py-2">
                  {t.exitDate ? `${t.exitDate} @ $${t.exitPrice.toFixed(2)}` : '—'}
                </td>
                <td className={`px-4 py-2 ${gainColor(t.return ?? 0)}`}>
                  {signedPct(t.return ?? 0)}
                </td>
                <td className="px-4 py-2 text-slate-500">{t.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Run page tests to verify they pass**

Run (from `web/`): `npx vitest run test/pages/PortfolioPage.test.jsx`
Expected: 3 tests PASS.

- [ ] **Step 6: Wire the route and nav link**

In `web/src/App.jsx`, add the import:

```jsx
import { PortfolioPage } from './pages/PortfolioPage.jsx';
```

and the route after the `/backtest` route:

```jsx
            <Route path="/portfolio" element={<PortfolioPage />} />
```

In `web/src/ui/NavBar.jsx`, add to `LINKS` after the Backtest entry:

```js
  { to: '/portfolio', label: 'Portfolio' },
```

- [ ] **Step 7: Add the App routing test**

In `web/test/App.test.jsx`:

Add to the `beforeEach` stub block:

```js
  vi.spyOn(api, 'getPortfolio').mockResolvedValue({ curve: [], trades: [], stats: {} });
```

Add a test inside the describe block:

```jsx
  it('navigates to the Portfolio page when its nav link is clicked', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('link', { name: /Portfolio/i }));
    await waitFor(() => expect(api.getPortfolio).toHaveBeenCalled());
    expect(await screen.findByText(/No signals to simulate yet/i)).toBeInTheDocument();
  });
```

- [ ] **Step 8: Run the full web suite**

Run (from `web/`): `npx vitest run`
Expected: all web tests pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/api/client.js web/src/pages/PortfolioPage.jsx web/src/App.jsx web/src/ui/NavBar.jsx web/test/pages/PortfolioPage.test.jsx web/test/App.test.jsx
git commit -m "feat: add simulated portfolio page with SPY/QQQ comparison"
```

---

### Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend suite + lint**

Run from repo root: `npm run lint && npm test`
Expected: clean.

- [ ] **Step 2: Full web suite**

Run from `web/`: `npx vitest run`
Expected: clean.

- [ ] **Step 3: Verify branch state**

Run: `git log --oneline main..HEAD`
Expected: the spec commit plus four feature commits, all on `claude/simulated-portfolio`.
