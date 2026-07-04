# ADR 0035 — IBKR Paper-Trading Execution

## Status

Accepted (2026-07-03).

## Context

Legion emitted signals but never acted on them: the only "portfolio" was an internal simulated
replay (2026-06-26 position-sizing feature) folding signals against synthetic fills. That fold
proved out the quality-weighted sizing math (`computeSizing`, `src/sizing/engine.js`) but never
saw a real fill, real slippage, or a real broker rejection — the gap between "the panel likes
this" and "an order actually executed" stayed untested. Closing it means submitting real orders
somewhere. A live account is out of scope (no human approval gate exists yet, and Legion's
consensus has no track record); a **paper account at a real broker** gets real market
mechanics — fills, off-hours resting, partial fills, symbol lookup failures — without capital
risk.

## Decision

Auto-submit every emitted signal to an IBKR **paper** account, full auto, no approval gate,
gated only by a dashboard kill switch and dry-run mode.

### Order-intent outbox (not a direct call from the emitter)

The emitter and the broker call are decoupled by a table, `legion.order_intents`
(`src/db/schema.sql`), rather than the emitter calling the broker inline in `finalize()`:

- `finalize()` writes one `pending` intent per emitted signal, snapshotting `band`, `conviction`,
  and `qualityMult` at emit time — guarded in a try/catch with the same posture as the
  `entryPrice`/quality fetches next to it (`src/emit/emitter.js`): a failed write logs loudly and
  **never blocks emission**. A missing intent for a signal is visible after the fact; a stuck
  emitter is not.
- A separate executor worker (`src/exec/executor.js`) polls the outbox (~15s) and does the
  broker call. This means a slow or unreachable IBeam gateway degrades to intents piling up
  `pending` — signals keep emitting, Telegram keeps notifying, the read API keeps serving —
  instead of a broker outage stalling the consensus pipeline that has nothing to do with order
  execution.
- The executor runs inside the emitter process (`src/run/emitter.js`) rather than as its own
  container: it shares the emitter's DB connection and lifecycle, and a poll loop has no need
  for independent scaling or a separate deploy unit.

### cOID dedupe as the crash-recovery primitive

The executor sets the broker's client order id (`cOID`) to the **intent's own id** on every
`placeOrder` call (`src/broker/ibkr.js`). This one choice is what makes the whole execution path
safe to crash at any point:

- If the process dies between a successful `placeOrder` and the DB write that marks the intent
  `submitted`, the intent is still `pending` on restart. A naive resubmit would double-order;
  instead `reconcilePendingAtBroker` (`src/exec/executor.js`) probes `getOrderStatus(intent.id)`
  first. IBKR already knows this `cOID` — the probe returns the real order state, and the
  executor reconciles (`filled`/`submitted`/`cancelled`) instead of resubmitting.
- The same probe is why a `submitted` intent's fill-tracking loop (`trackSubmitted`) is also the
  crash-recovery path for that state: whether the intent's own tick or a fresh process restart
  runs it, re-querying by `cOID` is the identical, idempotent operation.
- No separate "in-flight" lock or distributed transaction is needed — the broker's own
  duplicate-`cOID` rejection is the concurrency guard.

### Why IBeam, not a direct Client Portal integration

IBKR's Client Portal Web API requires an interactive login (2FA) and a session that must be
kept alive with periodic pings or it expires within minutes. [IBeam](https://github.com/Voyz/ibeam)
is a small, purpose-built container that owns exactly that: it drives the login flow headlessly
and re-authenticates on session expiry, exposing the same REST API on a stable internal URL
(`https://ibeam:5000/v1/api`). This keeps `src/broker/ibkr.js` a pure REST client with no
knowledge of IBKR's login mechanics, and keeps Legion's own `/ready` endpoint decoupled from
gateway health — a broker outage degrades trading (intents queue), it does not fail Legion's
liveness check.

The gateway serves HTTPS with a self-signed certificate; the adapter uses a dedicated undici
`Agent` with `rejectUnauthorized: false` scoped to gateway calls only (never a global TLS
override), one instance per broker object so calls share a connection pool instead of leaking
one per request.

### Paper-account assertion

At adapter `init()`, the resolved account id must start with `D` — IBKR's paper-account prefix —
or startup throws. This can only be bypassed by setting `LEGION_ALLOW_LIVE_BROKER=true`
explicitly. A credentials or gateway misconfiguration (e.g. a live account accidentally linked
into IBeam) must never silently start routing real orders; failing hard beats a config default
that fails open.

### Signal-driven exits only

There is no independent stop-loss, take-profit, or horizon-based auto-close. `computeSizing`
(`src/sizing/engine.js`) already treats every non-long band (`SELL`, `NO_CONSENSUS`) as a target
weight of zero; the executor sizes every intent — including one for a symbol the account already
holds — against the account's **actual** current position, so a SELL/HOLD signal after a prior
BUY naturally produces a closing (or trimming) order the next time the panel speaks for that
symbol. This keeps exits governed by the same consensus process as entries rather than adding a
second, unrelated decision system (e.g. a hard-coded max-drawdown trigger) that could fight the
panel's own read.

### Rollout sequence

The kill switch (`trading.enabled`, runtime key `trading_enabled`) defaults `false` and the
dry-run flag (`trading.dryRun`, runtime key `trading_dry_run`) defaults `true`
(`LEGION_TRADING_ENABLED=false`, `LEGION_TRADING_DRY_RUN=true` in `.env.example`) — a fresh
deploy is inert. Turning trading on is a two-step dashboard action, not a redeploy:

1. Deploy with defaults (`trading.enabled=false`) — the executor idles, no orders anywhere.
2. Toggle `trading_enabled` on from the dashboard with `trading_dry_run` still on. The full
   pipeline runs (gates, state fetch, sizing, dust filter) except the actual `placeOrder` call;
   intents land `skipped(dry-run)` with the would-be quantity and target weight logged and
   visible in the order log. This is the window to sanity-check sizing against a few real
   cycles before any capital moves, paper or not.
3. Toggle `trading_dry_run` off. The same intents now submit as real DAY market orders against
   the paper account.

Both toggles are runtime-config rows, so no redeploy is needed to move between stages or to
kill trading instantly if something looks wrong.

## Alternatives considered

- **Emitter calls the broker directly, synchronously, in `finalize()`.** Rejected: a slow or
  down gateway would then block signal persistence and Telegram delivery — the two things that
  work today and must keep working regardless of broker health. The outbox table decouples them
  by construction.
- **A queue/message-bus intent (NATS subject) instead of a DB table.** Rejected: the existing
  bus (ADR 0002) already accepted vote/cycle traffic reliably, but an order intent needs
  durable, queryable state (`pending`/`submitted`/`filled`/`skipped`/`failed`) that survives a
  restart and is directly the thing the dashboard's order log reads — a table is both the queue
  and the audit log with no separate read model to keep in sync.
- **Direct Client Portal integration (Legion drives the 2FA/session flow itself).** Rejected:
  reinvents session keepalive and re-auth that IBeam already solves, and couples Legion's own
  process to IBKR's login quirks.
- **Executor as its own container/process.** Rejected for v1: no independent scaling need, and
  running inside the emitter process means one fewer container to keep alive and no new
  inter-process coordination for something that only reads the same DB the emitter already
  writes to.
- **Horizon-based or hard stop-loss exits.** Rejected: would introduce a second, uncoordinated
  decision system fighting the panel's own read; signal-driven sizing already closes a position
  the panel no longer backs.

## Consequences

- A broker/gateway outage degrades to a growing `pending` outbox, not a stalled pipeline —
  signals, Telegram, and the read API are unaffected.
- Every order is traceable to the signal that caused it (`order_intents.signal_id`) and to its
  own snapshot of the inputs that sized it, independent of whatever the `signals` row looks like
  later.
- A process crash at any point in submit-then-persist can only ever leave **at most one** order
  in flight per intent, and it self-heals via the `cOID` probe on the next tick — no manual
  reconciliation runbook step is needed for the common crash case.
- Exits are only as good as the panel's own re-reads of a symbol; a held position with no fresh
  signal (e.g. a delisted/ignored ticker) has no independent mechanism to close it. This is an
  accepted v1 gap — the trading universe is "whatever the panel still votes on."
- A future non-IBKR broker (e.g. InnovestX/Settrade) is a new adapter implementing the same
  four-method interface (`init`/`getAccountSummary`/`getPositions`/`placeOrder`/`getOrderStatus`)
  behind `createBrokerFromConfig` (`src/broker/broker.js`) — nothing above the adapter layer
  changes.
