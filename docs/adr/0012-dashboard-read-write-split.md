# ADR 0012 — Dashboard: Thin Read API + Separate SPA + On-Demand Trigger

## Status

Accepted (2026-06-05); trigger endpoint added 2026-06-06.

## Context

Operators need to watch signals, inspect a debate round-by-round, manage the ticker list, and
see reliability/backtest results — without touching the running pipeline. The pipeline itself is
a set of bus-driven processes (ADR 0002) that should not grow a UI concern, and the dashboard
should be deployable and testable on its own.

## Decision

Split read/serve from compute.

- A **thin, data-only Express API** ([`src/api/app.js`](../../src/api/app.js)) reuses the same
  repo as the pipeline and exposes read routes (`/api/tickers`, `/api/cycles`, `/api/signals`,
  `/api/reliability`, `/api/backtest`) plus ticker config. It holds no business logic — it
  serializes persisted state.
- A **separate web SPA** under [`web/`](../../web) (Vite + React + Tailwind, its own
  `package.json` and test suite) talks to the API through a single seam,
  [`web/src/api/client.js`](../../web/src/api/client.js). Components are pure presentation,
  tested with Testing Library + jsdom.
- An **on-demand trigger** (`POST /api/trigger[/:symbol]`,
  [`src/api/routes/trigger.js`](../../src/api/routes/trigger.js)) lets an operator force a cycle
  instead of waiting for the 4 h cron; it needs the orchestrator+bus wired (returns 503 if the
  bus is down) and leaves the read routes unaffected.

## Alternatives considered

- **Server-rendered pages inside the pipeline** — couples UI to the compute processes and
  breaks independent deploy/test.
- **A write-heavy API that orchestrates cycles** — most of the surface is read; only the trigger
  needs write/compute, and it is isolated behind the optional orchestrator dependency.
- **Polling vs websockets** — the SPA fetches on mount/refresh; live push is deferred (the 4 h
  cadence does not need it).

## Consequences

- UI and pipeline evolve and deploy independently; the API stays a serialization layer.
- `vite preview` does not proxy `/api`, so the proxy target is env-driven (`LEGION_API_PROXY`,
  see ADR 0004).
- **Security note:** the trigger endpoint is unauthenticated and publicly reachable through the
  web ingress in prod, and it spawns LLM work — a `LEGION_TRIGGER_TOKEN` gate is a tracked
  follow-up.
