# Broker connections in DB + Webull TH adapter — design

Date: 2026-07-07. Builds on ADR 0035 (IBKR paper execution). Caveman-compressed.

## Problem

Broker linkage is env-only (`IBKR_GATEWAY_URL`), one hardcoded adapter. User trades a real
Webull Thailand portfolio and wants: (1) a Webull TH adapter, (2) broker linkage chosen and
configured per broker account from the dashboard, credentials in the DB, no env redeploy,
(3) paper first, flip to live later, (4) orders placed the moment a signal fires.

## Decision

One new table `legion.broker_connections`: many rows (IBKR paper, Webull TH paper, Webull TH
live…), exactly **one active** (partial unique index). The executor and `/api/portfolio`
resolve the active connection per tick/request through a small **broker manager** that
caches the adapter instance and rebuilds it when `(id, updated_at)` changes — switch broker
on the dashboard, next 15s tick trades on it. Env config for the broker is deleted
(`IBKR_GATEWAY_URL` gone); `LEGION_ALLOW_LIVE_BROKER` survives as the one hard safety gate:
a `paper=false` connection refuses to build without it.

Credentials live in the DB **encrypted at rest** (AES-256-GCM, key = SHA-256 of
`SESSION_SECRET`; prod already requires it). The API never returns secrets — write-only
fields, masked meta out.

## Table

```sql
CREATE TABLE legion.broker_connections (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,                -- display label ("Webull TH — paper")
  broker      TEXT NOT NULL,                -- 'ibkr' | 'webull'
  paper       BOOLEAN NOT NULL DEFAULT true,
  active      BOOLEAN NOT NULL DEFAULT false,
  credentials TEXT NOT NULL,                -- AES-256-GCM blob of the credentials JSON
  created_at / updated_at
);
CREATE UNIQUE INDEX ... ON broker_connections (active) WHERE active;  -- ≤ 1 active
```

Credential shapes: ibkr `{ gatewayUrl }` (IBeam still owns login); webull
`{ appKey, appSecret, accountId?, apiHost? }` (host default `https://api.webull.co.th`,
overridable for the TH sandbox/UAT host from the developer portal).

## Webull TH adapter (`src/broker/webull.js`)

Same six-method surface as ibkr.js. OpenAPI facts (from webull-inc/webull-openapi-python-sdk
+ webull-openapi-mcp, docs site is network-blocked in this environment):

- Host `api.webull.co.th`; auth = per-request HMAC signature, no session.
- Signed headers: `x-app-key`, `x-timestamp` (ISO-8601 UTC, seconds), `x-signature-version:
  1.0`, `x-signature-algorithm: HMAC-SHA256`, `x-signature-nonce` (uuid), plus `host`.
  `x-version: v2` sent but NOT signed. String-to-sign =
  `uri & sorted(k=v of lowercased signed headers + query params) & SHA256hex(compactBodyJSON).toUpperCase()`,
  then percent-encode the whole string (encodeURIComponent + `!'()*`), then
  base64(HMAC-SHA256(encoded, secret + '&')) → `x-signature`.
- Endpoints (x-version v2): GET `/openapi/account/list` → `[{account_id, account_type,
  account_label…}]`; GET `/openapi/assets/balance?account_id&total_asset_currency=USD` →
  `{total_cash_balance, total_market_value, total_net_liquidation_value?…}`; GET
  `/openapi/assets/positions?account_id` → `[{symbol, quantity, cost_price,
  instrument_type…}]`; POST `/openapi/trade/order/place` (header `category: US_EQUITY`)
  body `{account_id, new_orders:[{client_order_id, combo_type:NORMAL, symbol,
  instrument_type:EQUITY, market:US, order_type:MARKET, quantity, side, time_in_force:DAY,
  entrust_type:QTY, support_trading_session:CORE}]}` → `{order_id, client_order_id}`; GET
  `/openapi/trade/order/detail?account_id&client_order_id` → `{status, filled_quantity,
  filled_price…}`.
- Statuses: SUBMITTED / PARTIAL FILLED → submitted; FILLED → filled; CANCELLED / FAILED →
  cancelled; unknown → submitted + warn (same posture as ibkr.js).
- `client_order_id` ≤ 32 chars; adapter maps intent id → `legion<id>` symmetrically in
  placeOrder/getOrderStatus so cOID dedupe + reconcile keep working unchanged.
- Executor trades US equities (SPY/QQQ watchlist) on the TH account's US market access.

Paper safety: Webull's API can't prove an account is paper the way IBKR's D-prefix can, so
`paper` is declared on the connection; the flip to live additionally demands
`LEGION_ALLOW_LIVE_BROKER=true`. The test-connection endpoint surfaces
`account_type`/`account_label` so the user picks the right `accountId` with eyes open.

## API + UI

`/api/broker` (auth-gated like the rest): GET list (masked), POST create, PUT `/:id`
(secret fields blank = keep), DELETE, POST `/:id/activate` / `/:id/deactivate`, POST
`/:id/test` → builds that connection's adapter, `init()` + `getAccountSummary()`, returns
`{ok, accountId, equity, cash, accounts?}` (webull also lists accounts for the picker).
Config page gets a "Broker connections" section: list + activate radio + per-broker form +
test button. `/api/portfolio` gains `gateway.broker/connectionName/paper`.

## Latency (checked, unchanged)

Emitter INSERTs the order intent in the same emission path as the signal
(`src/emit/emitter.js` right after `addSignal`); executor drains every 15s and submits a
MARKET DAY order immediately — no end-of-day batching anywhere. The only "delay" is signal
cadence itself (ADR 0029 sweeps at 11:00/17:00 ET; 17:00-sweep orders are placed instantly
but rest until next open because the market is shut).

## Out of scope

Per-legion-user simultaneous books (executor stays one instance-level book, ADR 0035);
Webull market data; TH-market (SET) symbols; options.
