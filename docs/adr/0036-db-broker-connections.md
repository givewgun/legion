# ADR 0036 — DB-Configured Broker Connections + Webull TH Adapter

## Status

Accepted (2026-07-07). Builds on ADR 0035.

## Context

ADR 0035 shipped the executor with a single env-configured broker: `IBKR_GATEWAY_URL` picked
the IBeam gateway, `createBrokerFromConfig(cfg)` hardcoded the IBKR adapter, and changing
anything about the linkage meant editing env and redeploying. The user trades a real Webull
Thailand portfolio and wants Legion executing there — paper first, then the real account —
and wants broker linkage (which broker, which account, which credentials) chosen and
configured from the dashboard, with credentials stored in the DB rather than env.

## Decision

### Broker linkage is data, not deployment config

New table `legion.broker_connections`: one row per configured brokerage account (IBKR paper,
Webull TH paper, Webull TH live, …) with `name`, `broker` (`ibkr` | `webull`), `paper`,
`active`, and an encrypted `credentials` blob. A **partial unique index on `active`** holds
the ADR 0035 invariant — the executor is one instance-level book, so at most one connection
is active. Activation is a single UPDATE (`active = (id IS NOT DISTINCT FROM $1)`) so a
switch can't strand two actives.

`src/broker/manager.js` resolves the active row to an adapter instance, cached on
`(id, updated_at)`: the executor asks per tick and `/api/portfolio` per request, so a
dashboard edit/switch takes effect within one 15s tick, no restart. A row that fails to
build (live without the env gate, undecryptable blob) resolves to `{ broker: null,
connection }` and logs once — configured, but not tradable.

### Credentials: encrypted in the DB, write-only through the API

`src/broker/credentials.js` seals the credentials JSON with AES-256-GCM under a key derived
from `SESSION_SECRET` (already mandatory in prod — no new secret to provision). This
protects DB dumps/backups, not the host itself. The `/api/broker` routes never return
secrets — masked meta only; editing with blank secret fields keeps the stored values.
Rotating `SESSION_SECRET` orphans the blobs; the UI surfaces "credentials unreadable —
re-enter them" instead of a crypto error.

### The one env var that stays: the live-trading gate

`IBKR_GATEWAY_URL` is gone. `LEGION_ALLOW_LIVE_BROKER` remains, deliberately: a `paper=false`
connection refuses to build (and refuses dashboard activation) without it, so flipping to
real money always takes a redeploy-level act on top of the dashboard switch — the dashboard
alone can never move Legion from paper to live. This mirrors the ADR 0035 paper-account
assertion, generalized across brokers: for IBKR the D-prefix check stays armed on paper
connections; Webull's API cannot prove paper-ness, so `paper` is declared on the connection
and the test-connection endpoint shows `account_type`/`account_label` for eyes-open account
selection.

### Webull OpenAPI adapter

`src/broker/webull.js` implements the same six-method surface as `ibkr.js` against the
Webull OpenAPI (default host `api.webull.co.th`, overridable per connection for the
sandbox/UAT host). No gateway container: every request is individually signed
(HMAC-SHA256 over a canonical string of signed headers + query + body hash — the scheme
implemented by webull-inc/webull-openapi-python-sdk). Trade surface: `/openapi/account/list`,
`/openapi/assets/balance`, `/openapi/assets/positions`, `/openapi/trade/order/place`
(MARKET / DAY / QTY, `category: US_EQUITY`), `/openapi/trade/order/detail`.

Executor semantics carry over unchanged because the adapter preserves the contract ADR 0035
leans on: `clientOrderId` (the intent id) maps symmetrically to Webull's `client_order_id`
as `legion<id>` in both placeOrder and getOrderStatus, so cOID-keyed dedupe, the
probe-before-fail discipline, and crash recovery all work identically. Status mapping:
SUBMITTED / PARTIAL FILLED → `submitted`, FILLED → `filled`, CANCELLED / FAILED →
`cancelled`, unknown → `submitted` + warning.

### Order timing

Unchanged and verified: the emitter INSERTs the order intent in the same `finalize()` path
that stores the signal, and the executor drains pending intents every 15s tick, submitting
a MARKET DAY order immediately — there is no end-of-day batching. The only latency between
"signal fires" and "order at the broker" is the poll interval; orders from the post-close
sweep (ADR 0029) are placed instantly but rest at the broker until the next session opens.

## Consequences

- Adding a broker = one adapter module + one `case` in `createBrokerFromConnection` + a
  field list in the routes/UI. InnovestX (Settrade) remains a future sibling.
- The executor now always starts when GunVest is configured; with no active connection it
  idles and intents accumulate as `pending`, visible on the dashboard.
- `/api/portfolio` reports `gateway.broker/connectionName/paper` so the dashboard shows
  which book it is looking at.
- Backups of the legion DB now contain (encrypted) brokerage credentials; treat
  `SESSION_SECRET` with corresponding care.
