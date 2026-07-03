# IBKR Paper-Trading Execution — Design

**Date:** 2026-07-03
**Status:** Approved design, pending implementation plan

## Purpose

Connect Legion's signal pipeline to a **real broker paper account**: when a
signal emits, size it with the existing quality-weighted sizing engine and
**auto-submit a real order to the IBKR paper account** — no human in the loop.
The IBKR paper account becomes the live paper book (real fills, real slippage,
real market hours), replacing the internal simulated fold built in the
2026-06-26 position-sizing feature.

Builds directly on shipped code (PRs #62/#63): `src/quality/`,
`src/sizing/engine.js` (`computeSizing`), the emitter's `qualityMult` +
`entryPrice` snapshot on `signal.plan`, and `legion.holdings`. This design adds
only the execution layer.

## Decisions (locked during brainstorm)

| Question | Decision |
| --- | --- |
| Execution mode | Full auto to **paper** account, no approval gate |
| Brokers | IBKR now; broker interface designed so an InnovestX (Settrade) adapter can slot in later — **no InnovestX code in v1** |
| Transport | IBKR **Client Portal Web API** behind an **IBeam** gateway container (REST/JSON, fits Legion's fetch + `util/resilient.js` patterns; IBeam owns login/keepalive) |
| Off-hours signals | Submit immediately; DAY market order rests at IBKR until next open |
| Exits | **Signal-driven only**: SELL / NO_CONSENSUS → close; weaker BUY → trim; stronger BUY → add. No horizon-based auto-close |
| Internal paper book | **Replaced** by the IBKR paper account (old fold deleted, not maintained) |
| Guardrails | Dashboard kill switch + dry-run mode (default ON at first deploy); paper-account assertion in the adapter |
| Architecture | **Order-intent outbox** (approach B): emitter writes an intent row; a separate executor worker reconciles and submits |

## Non-Goals (YAGNI)

- InnovestX / Settrade implementation (interface only)
- Live-money trading (paper account asserted at startup)
- Limit orders, algos, brackets, stop orders — DAY market orders only
- Fractional shares (quantities rounded to whole shares)
- Per-user broker accounts — one instance-level IBKR paper account
- Options, shorts, non-USD instruments
- Approval workflow / human gate (kill switch + dry-run are the controls)

## Architecture

```
emitter.finalize()                    executor loop (~15s)              IBeam gateway
  ├─ persist signal                     ├─ load pending intents           (docker, CP API)
  ├─ snapshot entryPrice/qualityMult    ├─ gate: kill switch / dry-run        │
  └─ INSERT order_intents (guarded) ──▶ ├─ fetch equity + positions ─────────▶│──▶ IBKR paper
                                        ├─ computeSizing → deltaShares        │
                                        ├─ place DAY market order (cOID) ────▶│
                                        └─ poll fill → update intent          │
```

### 1. Broker abstraction — `src/broker/`

- `broker.js` — interface contract (JSDoc-typed factory):
  `getAccountSummary()` → `{ accountId, equity, cash }`;
  `getPositions()` → `[{ symbol, qty, avgCost }]`;
  `placeOrder({ symbol, side, qty, clientOrderId })` → `{ brokerOrderId }`;
  `getOrderStatus(brokerOrderId | clientOrderId)` → `{ status, fillQty, avgFillPrice }`.
  Plain async functions with an injected `fetchImpl`, mirroring
  `src/data/gunvest.js`.
- `ibkr.js` — Client Portal API adapter against the IBeam gateway:
  - `/iserver/accounts` — account discovery + auth check.
  - `/iserver/secdef/search` — symbol → conid resolution, cached in-process
    (conids are stable).
  - `/iserver/account/:acct/orders` — order placement with `cOID` set to the
    intent id (broker-side duplicate rejection).
  - `/iserver/reply/:replyId` — **auto-confirm the precautionary dialogs** the
    CP API returns on order placement (loop until an order id comes back).
  - `/iserver/account/orders` — order status lookup by `cOID` for fill polling
    and crash recovery.
- **Paper-account assertion:** at adapter init, the resolved account id must
  start with `D` (IBKR paper prefix) unless `LEGION_ALLOW_LIVE_BROKER=true` is
  set. Fail hard at startup otherwise — a credentials misconfiguration must
  never route orders to a live account.
- InnovestX later = a sibling `innovestx.js` implementing the same four
  methods; nothing else in the system changes.

### 2. Order-intent outbox — `legion.order_intents`

New table in `src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS legion.order_intents (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT REFERENCES legion.signals(id),
  symbol TEXT NOT NULL,
  band TEXT NOT NULL,
  conviction NUMERIC,
  quality_mult NUMERIC,
  target_weight NUMERIC,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|submitted|filled|skipped|failed
  skip_reason TEXT,                         -- dry-run | kill-switch | dust | ...
  broker_order_id TEXT,
  submitted_qty NUMERIC,
  fill_qty NUMERIC,
  fill_price NUMERIC,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

- **Written by the emitter** in `finalize()` immediately after the signal
  persists, inside a try/catch with the same posture as the existing
  `entryPrice` / `qualityMult` fetches: a failed intent write logs an error and
  never blocks signal emission.
- One intent per emitted signal for symbols in the trading universe; the
  intent snapshots `band`, `conviction`, `quality_mult` so the executor's
  decision is auditable even if the signal row later changes shape.

### 3. Executor worker — `src/exec/executor.js`

A polling loop (~15s) inside the main Legion process (no new container).
Per pending intent, oldest first:

1. **Gates.** `trading.enabled` (runtime_config) off → leave pending, log once.
   `trading.dryRun` on → run the full pipeline below except order submission;
   mark `skipped` with `skip_reason='dry-run'` and log the would-be order.
2. **State fetch.** `getAccountSummary()` (equity) + `getPositions()` for the
   symbol. Equity fetch failure → leave intent pending, retry next loop —
   never size against unknown equity.
3. **Sizing.** Reuse `computeSizing()` from `src/sizing/engine.js` with the
   intent's snapshot inputs and the **actual IBKR position** — the delta is
   computed against reality, so a previously missed order self-corrects on the
   next signal. SELL / NO_CONSENSUS → `targetWeight = 0` → close.
4. **Dust filter.** `|deltaUSD| < trading.minOrderNotional` (default $50) or
   rounded shares = 0 → `skipped(dust)`.
5. **Submit.** DAY market order via `placeOrder` with
   `clientOrderId = intent id`. Status → `submitted`, store `broker_order_id`
   and `submitted_qty`.
6. **Fill tracking.** Each loop, re-check `submitted` intents via
   `getOrderStatus`; on fill record `fill_qty` / `fill_price`, status →
   `filled`. Orders resting overnight simply stay `submitted` — normal.
7. **Crash recovery.** On startup, `submitted` intents are re-queried by
   `cOID` before any new submission; `pending` intents just resume. The `cOID`
   dedupe means a crash between submit and DB update cannot double-order.

Serialization: the executor processes intents one at a time (single loop, no
concurrency), so per-symbol ordering is inherent.

### 4. Equity snapshots + paper book — IBKR replaces the fold

- New table `legion.paper_equity_snapshots (id, ts TIMESTAMPTZ, equity NUMERIC,
  cash NUMERIC)`. The executor snapshots NetLiquidation **hourly during US
  market hours and after every fill**. Own snapshots beat the CP API's shallow
  performance history and survive paper-account resets.
- `src/portfolio/paper-book.js` (pure fold) and its wiring are **deleted**.
- `/api/portfolio/paper` is rebuilt to serve:
  - **Equity curve** from `paper_equity_snapshots`.
  - **Benchmarks**: SPY/QQQ normalized from book inception (first snapshot)
    using existing gunvest daily candles — same three-leg chart as before.
  - **Open positions** live from `getPositions()` + gunvest prices (market
    value, unrealized P/L vs IBKR avg cost).
  - **Order log**: the `order_intents` table, newest first.

### 5. Dashboard

- Paper Trading page replaces the simulated-portfolio view: equity curve vs
  SPY/QQQ, open-positions table, order log with status chips
  (`pending / submitted / filled / skipped(reason) / failed(error)`).
- **Controls**: kill-switch and dry-run toggles writing `trading.enabled` /
  `trading.dryRun` in runtime_config — same pattern as the cycle-stop controls
  (PR #71).
- **Gateway health chip**: IBeam reachable + CP session authenticated
  (`/iserver/auth/status`), red when down.

### 6. Deployment

- `voyz/ibeam` container added to the prod compose on the Coracle VM. Paper
  credentials via env from the existing `private/` secrets path. Exposes the
  gateway only on the internal compose network.
- Legion env: `IBKR_GATEWAY_URL` (e.g. `https://ibeam:5000/v1/api`),
  `LEGION_ALLOW_LIVE_BROKER` unset.
- IBeam owns login, session keepalive, and re-auth. Legion's `/ready` is
  **not** coupled to gateway health — trading degrades (intents stay pending),
  signals keep flowing.
- Rollout sequence: deploy with `trading.enabled=false` (defaults) → turn
  `trading.enabled` on with `trading.dryRun` still on and observe a few cycles
  of logged would-be orders → turn `trading.dryRun` off from the dashboard to
  go live-paper.

## Config (runtime_config keys, defaulted)

| Key | Default | Meaning |
| --- | --- | --- |
| `trading.enabled` | `false` | Kill switch; executor no-ops when false |
| `trading.dryRun` | `true` | Full pipeline, no submission |
| `trading.minOrderNotional` | `50` | Dust filter, USD |

Sizing knobs (`baseWeight`, `maxPerName`) stay where they live today in the
sizing engine config.

## Error Handling

- **Gateway down / unauthenticated** → intents stay `pending`, executor
  retries with backoff, dashboard chip red. Nothing lost.
- **Order rejected by IBKR** → `failed` + broker error text. No auto-retry:
  a rejection carries information a human should read.
- **Fill poll finds order cancelled/expired** (unfilled DAY order) → `failed`
  with reason; next signal for the symbol re-sizes against actual position.
- **conid resolution failure** → `failed('unknown symbol')`.
- **Equity/position fetch failure** → intent held `pending`; never size
  against stale or unknown account state.
- **Intent write failure at emit** → signal emits normally; error logged
  (visible as a signal without a matching intent).

## Testing

- **`ibkr.js` adapter** (mocked `fetchImpl`): auth status, account discovery +
  paper-account assertion (live id throws unless override), conid
  resolve + cache, order placement including the reply-confirmation loop,
  order status by `cOID`.
- **Executor** (fake broker object): full status machine
  (pending→submitted→filled / skipped / failed), kill-switch and dry-run
  gates, dust filter, delta-vs-actual-position math (including
  close-on-SELL and trim), equity-failure hold, crash recovery re-query by
  `cOID`, snapshot-after-fill.
- **Emitter**: intent row written on finalize with snapshot fields; intent
  write failure never blocks emission.
- **Routes**: `/api/portfolio/paper` shape (curve + benchmarks + positions +
  order log), runtime_config toggle endpoints.
- **Manual smoke**: dry-run on prod for a few cycles → inspect logged orders →
  enable live-paper from dashboard.

## Open Knobs (defaulted, override later)

- Executor poll interval (~15s), snapshot cadence (hourly in-market).
- `trading.minOrderNotional` ($50).
- Trading universe = all emitted-signal symbols (no allowlist in v1).
