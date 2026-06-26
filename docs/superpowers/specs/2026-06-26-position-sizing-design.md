# Quality-Weighted Position Sizing — Design

**Date:** 2026-06-26
**Status:** Approved design, pending implementation plan

## Purpose

Scale Legion's signal conviction by **company quality** (fundamentals, analyst,
valuation, moat) into a position size, and apply that sizing to **two books that
share one pure sizing engine**:

1. **Live paper book** — *replaces* the existing deterministic replay sim. On
   every signal emit it records a simulated fill at the **live price captured at
   signal-fire time** (already persisted on the signal — see below), sized by
   conviction × quality. Marked to market continuously at the current live price,
   benchmarked vs SPY/QQQ.
2. **Real holdings book** — a manually-entered portfolio. For each held name,
   shows live market value, unrealized P/L, and a **recommended target weight**
   (same engine) expressed as a buy/trim $ delta. **Suggests only** — never
   trades, syncs a broker, or moves money.

The engine, quality scoring, and live-price layer are shared; the two books are
just different consumers of the same `qualityMult` and sizing function.

### Key reuse: emit-time price is already captured

`emitter.finalize()` (`src/emit/emitter.js`) already fetches the live price of
the symbol **and** SPY/QQQ at the instant a signal fires and stores
`entryPrice / spyEntryPrice / qqqEntryPrice` on the signal row (ADR 0009). The
old sim ignored these and filled at the *next daily close* instead. The live
paper book simply **fills at the stored `entryPrice`** — no new execution path,
no intraday scheduler. We additionally snapshot `qualityMult` onto the signal at
emit so the paper fill is both emit-priced and quality-weighted, and the book
stays a pure, reproducible fold over the signals table (no positions table).

## Non-Goals (YAGNI)

- Automated trading or order routing (real book is suggest-only; paper book is simulated)
- Broker/account sync (real holdings are entered manually)
- Options, derivatives, short positions
- Tax-lot accounting, wash-sale tracking
- Multi-currency / non-US equities
- Server-push streaming (client polling is sufficient)
- Preserving the old deterministic close-replay sim (explicitly replaced; the
  paper book's intraday mark-to-market is inherently live, not reproducible to
  the tick — entry fills and benchmarks remain reproducible via the snapshot)

## Inputs and Where They Come From

| Input | Source | Refresh |
| --- | --- | --- |
| Holdings (symbol, shares, avg cost) | Manual entry → `legion.holdings` table | On user edit |
| Live price | gunvest `GET /api/market/:ticker` via existing `gunvest.getPrice` (Yahoo + finnhub fallback, server-side in gunvest) | ~20s client poll; gunvest-side cache |
| Latest signal (band, conviction) | Existing Legion debate output | Per cycle |
| Risk cap (`capConviction`) | Existing risk manager | Per cycle |
| Fundamentals + valuation | gunvest `GET /api/stocks/:ticker/fundamentals` (exists) via new client method | Daily client cache |
| Analyst consensus | Same gunvest `/fundamentals` endpoint **after a small gunvest-side add** (`recommendationTrend` + target fields) | Daily client cache |
| Moat score | LLM-scored from gathered context | Daily cache |

Two clocks: **fast** = price only (intraday re-pricing of value/P&L/current
weight + target delta); **slow** = fundamentals + moat (`qualityMult`, sticky
through the day). Fundamentals don't move intraday, so intraday recompute reuses
the cached `qualityMult` and only varies price-driven terms.

## Architecture

### 1. Holdings store (manual entry)

- New table **`legion.holdings`**, mirroring gunvest's `holdings_cache`
  column shape so it's plug-and-play with the shared gunvest-db later:
  `id, user_id, ticker, asset_type DEFAULT 'stock',
  shares NUMERIC(18,8), avg_cost NUMERIC(18,8), total_cost NUMERIC(18,8),
  realized_pl NUMERIC(18,8) DEFAULT 0, dividends NUMERIC(18,8) DEFAULT 0,
  currency DEFAULT 'USD', updated_at TIMESTAMPTZ, UNIQUE(user_id, ticker)`.
- **`user_id BIGINT NOT NULL REFERENCES legion.users(id) ON DELETE CASCADE`** —
  Legion already has real multi-tenant auth (`legion.users`, Google OAuth,
  `req.session.userId` → `req.user`, alongside `user_watchlist` /
  `user_portfolio_config`). Holdings are scoped to the authenticated user, same
  as the existing watchlist. Not a default-1 placeholder. (gunvest's
  `holdings_cache` uses an `INTEGER` user_id against its own users table; the
  later merge maps user ids regardless — plug-and-play is about column shape, not
  the id value.)
- Added to `src/db/schema.sql` (single-file schema, `legion` schema namespace).
- CRUD route group `/api/portfolio/holdings` (list / create / update / delete).
- Entry UI on the existing portfolio page: add/edit/delete a holding row
  (ticker, shares, avg cost, optional note). User enters shares + avg cost
  directly — no transaction ledger in this iteration (YAGNI).

### 2. Data feeds — consume gunvest's REST API (don't re-port)

Legion already treats gunvest's backend as its data layer: `createGunvestClient`
(`src/data/gunvest.js`) wraps `/api/market`, `/api/news`, `/api/sentiment`,
`/api/macro` with a bounded limiter + retry, and the emitter already pulls live
price via `gunvest.getPrice`. gunvest's Yahoo logic runs **server-side there**, so
Legion should call it, not duplicate it. **No FMP, no Yahoo scraping in Legion, no
crumb/axios/p-retry added to Legion.**

- **Live price** — `gunvest.getPrice(symbol)` → `GET /api/market/:ticker`
  (gunvest `priceService`, Yahoo + finnhub fallback). **Already wired**; reused
  as-is for mark-to-market and the emit-time `entryPrice`.
- **Fundamentals + valuation** — gunvest already exposes
  `GET /api/stocks/:ticker/fundamentals` (`fundamentalsService`, finnhub
  `/stock/metric` primary, Yahoo `quoteSummary` fallback) returning trailing/
  forward P/E, PEG, P/S, P/B, EV/EBITDA, margins, ROE/ROA, growth, FCF,
  debt-to-equity, sector. Add one method `getFundamentals(symbol)` to Legion's
  gunvest client hitting this endpoint. **No port.**
- **Analyst consensus** — the one data gap: gunvest's `fundamentalsService`
  does not yet fetch analyst fields. Small cross-repo change in gunvest: add
  `recommendationTrend` to the `quoteSummary` MODULES and map
  `financialData.targetMeanPrice / recommendationKey / numberOfAnalystOpinions`,
  surfaced through the same `/fundamentals` endpoint. Legion consumes it via the
  same client method. (If deferred, the analyst sub-score degrades to neutral —
  see §3 — so this is not a blocker.)
- **Caching** — fundamentals cached client-side in Legion with a daily TTL (the
  existing `feeds/cache.js`); gunvest already caches its own Yahoo calls
  (~10 min) so Legion's daily cache mostly avoids cross-service chatter.

### 3. Quality scoring — `src/quality/`

Computes four sub-scores, each **normalized to [0,1]**, then blends them into a
single `qualityMult ∈ [0.5, 1.5]`.

- **fundamentals** — margins, ROE/ROA, revenue/earnings growth, FCF, debt-to-equity
  (Yahoo `quoteSummary` fields already returned by the ported service)
- **analyst** — `recommendationKey` + `targetMeanPrice` upside vs live price +
  `numberOfAnalystOpinions` + `recommendationTrend` direction (Yahoo)
- **valuation** — trailing/forward P/E, PEG, P/S, P/B, EV/EBITDA; cheaper → higher
  score (Yahoo)
- **moat** — LLM-scored durability (pricing power, switching costs, network
  effects) from news/filings the agents already gather; reuses the existing
  provider/tiered LLM path. Cached daily.

Blend: weighted average of the four sub-scores (default **equal 25% each**),
mapped from [0,1] onto the `[0.5, 1.5]` multiplier range.

**Degradation:** a missing factor contributes a **neutral 0.5** (mid) and raises
a flag, rather than blocking the score — mirrors the risk-manager fallback
pattern (`computeConstraint` returns a safe default on data failure). Flags
surface in the UI so the user knows a recommendation is running on partial data.

### 4. Sizing engine — `src/sizing/` (pure function, TDD)

```
targetWeight = clamp(BASE_WEIGHT × conviction × qualityMult, 0, MAX_PER_NAME)
```

- Only long/BUY names are sized up. SELL and NO_CONSENSUS → `targetWeight = 0`
  (recommend trim to zero).
- `conviction` already carries the risk manager's `capConviction` (it caps
  conviction upstream, so the cap flows through naturally).
- Inputs: latest signal, `qualityMult`, current position (shares, avg cost),
  live price, total portfolio market value, caps/config.
- Output per name:
  - `currentWeight`, `targetWeight`
  - `deltaUSD`, `deltaShares`
  - `action` ∈ {buy, trim, hold}
  - `marketValue`, `unrealizedPnl`, `unrealizedPnlPct`
  - `flags` (partial-quality, stale-price, etc.)
- Pure and fully unit-testable — no I/O, no LLM. All data is passed in.

**Config defaults (overridable):**
- `BASE_WEIGHT` — set so a full-conviction, average-quality (mult ≈ 1.0) name
  targets ~5%.
- `MAX_PER_NAME` — 10%.
- factor weights — equal (25% each).

### 5. Live paper book — replaces the deterministic sim

The emitter already captures `entryPrice` at signal-fire (ADR 0009). Two small
changes turn the replay sim into a live, quality-weighted paper book:

- **At emit** (`emitter.finalize`): compute `qualityMult` for the symbol (from
  the quality service, daily-cached) and persist it on the signal alongside the
  existing `entryPrice` — store in the signal `plan` JSONB (no schema change) or
  a dedicated column. This snapshots the two sizing inputs that vary over time.
- **Rewrite `src/portfolio/simulate.js`** (or a sibling `paper-book.js`) as a
  pure fold over signals that:
  - **Enters at `signal.entryPrice`** (emit-time live) at the emit timestamp —
    not the next daily close.
  - **Sizes via the shared engine**: `conviction × signal.qualityMult ×
    BASE_WEIGHT × equity`, same function the real book uses.
  - Exits on horizon (`resolveAfter`) or an opposing signal (unchanged rules).
  - **Marks open positions to market at the current live Yahoo price**;
    benchmarks ride the captured `spyEntryPrice/qqqEntryPrice` (ADR 0009), so
    all three legs share the "entered at signal time" base.
- Entry fills and benchmark bases stay reproducible (snapshotted on the signal);
  only the intraday mark-to-market of still-open positions is live.

### 6. API + Web

- **`/api/portfolio/sizing`** — the **real book**: joins `legion.holdings` +
  live price + latest signals + cached quality, runs the sizing engine, returns
  recommendation rows plus a portfolio-level summary (total value, total
  unrealized P/L, cash/uninvested implied by target weights summing < 100%).
- **`/api/portfolio/paper`** (extends the existing simulated-portfolio route) —
  the **live paper book**: equity curve vs SPY/QQQ, open positions marked at live
  price, trade log. Now quality-weighted and emit-priced.
- **Portfolio page** — gains a holdings table: ticker, shares, market value,
  **weight now → target**, **buy/trim $**, unrealized P/L, and a quality
  breakdown tooltip (the four sub-scores + flags).

### 7. Refresh model

- **Client polls** `/api/portfolio/sizing` (and `/paper`) every ~20s while the page is open.
- Server serves live Yahoo quotes from the ~90s `feeds/cache.js` cache (Yahoo is
  keyless with no per-call quota, so the cache exists to cut latency/load, not to
  ration a quota); recomputes market value, P/L, current weight, and target delta
  on each call.
- Fundamentals + moat → `qualityMult` resolved from the daily cache (recomputed
  on its own daily cadence or on demand), so intraday polls are cheap.
- No server-push transport; polling is sufficient for a personal dashboard.

## Gunvest Reuse Audit (build vs already-there)

Cross-checked against `C:\Users\gunka\OneDrive\Documents\financial\gunvest`.

| Capability | Status in gunvest | Legion work |
| --- | --- | --- |
| Live price (Yahoo + finnhub fallback) | `priceService` + `GET /api/market/:ticker` | **None** — already consumed via `gunvest.getPrice` |
| Fundamentals + valuation | `fundamentalsService` + `GET /api/stocks/:ticker/fundamentals` | Add one `getFundamentals` client method |
| Analyst consensus | **Missing** — modules don't include `recommendationTrend`/target | Small **gunvest** add (modules + mapping), then consume; degrades to neutral if deferred |
| Holdings snapshot math (value, P/L, %, weight, day P/L) | `portfolioService.getPortfolioSnapshot` | Port the per-position math into Legion's sizing engine (logic reference, not a dependency) |
| Position caps / trim / stop rules | `config/portfolio.js` `RULES` (`maxPositionPct 0.20`, `specMaxPct 0.05`, profit-taking, stop-loss) | Reference for caps. **Note:** gunvest caps a name at **20%** / spec **5%**; this spec's default `MAX_PER_NAME` is **10%** — reconcile (kept 10% unless overridden) |
| Category allocation targets | `config/portfolio.js` `ALLOCATION_TARGETS` | Optional later overlay (per-category cap); out of scope for v1 |
| Real holdings seed data | `config/portfolio.js` `POSITIONS.stocks` (real shares/avgCost) | Seed `legion.holdings` for the authed user |
| Positions source of truth | gunvest = `transactions` FIFO ledger; `holdings_cache` is derived | Legion v1 = **direct manual `holdings` entry** (no ledger). Same column shape as `holdings_cache` keeps a later ledger-backed merge open |
| HTTP retry/cache utils | `httpRetry.js` (axios/p-retry), `utils/cache.js` | **Not ported** — Legion uses its own `util/resilient.js` + `feeds/cache.js` |
| Frontend holdings UI | `Holdings.jsx` / `Portfolio.jsx` (gunvest React app) | Visual reference only; Legion's own web app renders the table |

## Error Handling

- Missing fundamentals/analyst/valuation → neutral 0.5 sub-score + flag; sizing
  still produces a recommendation.
- Missing moat (LLM unavailable) → neutral 0.5 + flag.
- Missing live price → fall back to last known price, mark `stale-price` flag;
  P/L and weights shown against the stale value rather than blanking the row.
- No signal for a held name → treat as NO_CONSENSUS (target 0 / trim), flagged.
- Partial data degrades gracefully and never blocks the holdings table.
- **Emit-time quality fetch fails** → snapshot a neutral `qualityMult = 1.0` on
  the signal + flag, so the paper fill still happens at `entryPrice` and never
  blocks the emitter hot path (mirrors the existing `entryPrice` try/catch).

## Testing

- **Sizing engine** — pure-function unit tests first (TDD): weight formula,
  clamping at `MAX_PER_NAME`, BUY vs SELL vs NO_CONSENSUS direction, delta
  math, P/L math, flag propagation.
- **Quality normalization** — unit tests for each sub-score's [0,1] mapping,
  the blend, the `[0.5, 1.5]` range, and missing-factor degradation.
- **gunvest client** — `getFundamentals` method with a mocked `fetchImpl`:
  endpoint shape parse, retry/limiter path (existing pattern), missing fields →
  safe nulls. (Live price/`getPrice` already covered by existing client tests.)
- **Live paper book** — pure-fold unit tests: entry at `signal.entryPrice` (not
  next close), quality-weighted sizing, horizon + opposing-signal exits,
  benchmark base from captured `spyEntryPrice/qqqEntryPrice`, live
  mark-to-market of open positions, neutral-quality fallback fill.
- **Emitter snapshot** — `finalize` persists `qualityMult` on the signal; quality
  fetch failure → neutral 1.0 + flag, hot path never blocks.
- **Routes** — `/api/portfolio/holdings` CRUD, `/api/portfolio/sizing`, and
  `/api/portfolio/paper` join/shape, including partial-data and degraded paths.

## Open Knobs (defaulted, override later)

- `BASE_WEIGHT`, `MAX_PER_NAME` (10%), factor weights (equal 25%).
- Client poll interval (~20s).
- Fundamentals daily client TTL; live price cache is gunvest-side (reused as-is).
