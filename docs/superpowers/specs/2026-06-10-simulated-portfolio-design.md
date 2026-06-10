# Simulated Portfolio Page — Design

**Date:** 2026-06-10
**Status:** Approved

## Goal

A web page that simulates a paper portfolio driven by Legion's emitted signals and
compares its equity curve against buy-and-hold SPY and QQQ. Answers the question:
"if I had traded every signal Legion emitted, would I have beaten the index?"

## Background / Constraints

- Signals are stored in `legion.signals` with `band` (STRONG_SELL..STRONG_BUY |
  NO_CONSENSUS), `conviction` (0–1), and a `plan` JSONB.
- The `plan` JSONB does **not** contain entry/stop/target/size (despite the schema
  comment). `src/emit/plan.js` only writes `horizon: 'swing'`, rationales, score,
  quorum. The simulation therefore derives trades from `band` + `conviction` +
  the system-wide `horizonDays` config (default 5) — the same horizon the
  reliability resolver uses to score signals.
- Price data comes from `gunvest.getCandles(symbol, days)` (daily candles with
  `date` and `close`), already used by `src/run/backtest.js`.
- The web app is React + Vite with `recharts` already installed.

## Decisions

| Question | Decision |
| --- | --- |
| Trade rules | Conviction-sized long entries, horizon exit (plan fields unavailable) |
| Time scope | Replay all historical signals from the DB; recomputed on demand |
| Benchmark | Both SPY and QQQ, buy-and-hold from first signal date, same capital |
| Compute | On-demand in the API with a short in-memory cache; no new tables |

## Components

### 1. Simulation engine — `src/portfolio/simulate.js`

Pure function, no I/O (same pattern as `src/backtest/deterministic.js`).

```
simulatePortfolio(signals, candlesBySymbol, spy, qqq, {
  startingCapital = 100_000,
  horizonDays = 5,
  maxPositionFraction = 0.10,
})
```

**Trade rules:**

- `BUY` / `STRONG_BUY` → open a long position.
  - Size = `conviction × maxPositionFraction × current equity`, capped at available cash.
  - Entry price = `close` of the first candle on or after the signal's `created_at` date.
  - If the symbol already has an open position, skip (no pyramiding).
- `SELL` / `STRONG_SELL` → close any open position in that symbol at that day's close.
  No short positions are opened.
- `HOLD`, `NO_CONSENSUS`, or `conviction === 0` → ignored.
- Auto-exit: any position still open `horizonDays` *trading days* after entry is
  closed at that day's close.
- Missing candle data for a symbol/date → skip the trade (count in a `skipped` stat).

**Equity curve:** for every trading date from the first signal date to the last
available candle, mark all open positions to market at that day's close and record
`cash + Σ(position value)`. Benchmarks: SPY and QQQ buy-and-hold of
`startingCapital` from the same start date.

**Output:**

```js
{
  curve: [{ date, equity, spy, qqq }],
  trades: [{ symbol, band, conviction, entryDate, entryPrice, shares,
             exitDate, exitPrice, return, exitReason }], // exitReason: 'horizon' | 'sell-signal' | 'open'
  stats: { totalReturn, spyReturn, qqqReturn, maxDrawdown, winRate, trades, skipped },
}
```

### 2. API — `GET /api/portfolio`

New route file `src/api/routes/portfolio.js`.

- Loads all signals (new repo method `listAllSignals()` — existing `listSignals`
  caps at 50), collects distinct symbols, fetches candles for each plus SPY/QQQ
  via gunvest, runs `simulatePortfolio`, returns the JSON above.
- In-memory cache with ~10 minute TTL keyed on nothing (single entry) — candle
  fetches are the slow part; signals change at most once per cycle.
- Wiring: `createApp` (in `src/api/app.js`) gains a `gunvest` dependency;
  `src/run/api.js` constructs it via `createGunvestFromConfig(cfg)` like
  `run/backtest.js` does.

### 3. Web page — `web/src/pages/PortfolioPage.jsx`

- Route `/portfolio`, nav link added alongside existing pages in `App.jsx`.
- Recharts `LineChart`: three lines — portfolio equity, SPY, QQQ.
- Stat cards: total return, vs SPY, vs QQQ, max drawdown, win rate, trade count.
- Trades table: symbol, band, conviction, entry date/price, exit date/price,
  return, exit reason.
- Loading / error / empty (no signals yet) states matching existing pages.

## Error handling

- Gunvest fetch failure for one symbol → skip that symbol's trades, count as
  skipped; fail the whole request only if SPY/QQQ (benchmark) fetches fail.
- API errors surface through the existing Express error middleware.
- Web page shows the standard error state on non-200.

## Testing

- `test/portfolio/test-simulate.js` — deterministic candle/signal fixtures:
  conviction sizing, horizon exit, early sell exit, no pyramiding, cash cap,
  benchmark curve, skipped trades on missing data, empty signal list.
- API route via supertest with mocked repo + gunvest (follows existing route tests).
- `web/test/pages/PortfolioPage.test.jsx` — render with mocked fetch: chart
  present, stats shown, error and empty states.

## Out of scope

- Short positions, stop-loss / take-profit (no data for them in plans).
- Persisting simulation results to the DB.
- Configurable starting capital / sizing from the UI (constants for now).
