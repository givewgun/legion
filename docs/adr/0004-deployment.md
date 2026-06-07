# ADR 0004 — Single-VM Docker Deployment on Oracle A1

## Status

Accepted (2026-06-04); refined 2026-06-06 (shared-network deploy, CI gating).

## Context

The project targets ≈$0 runtime. The available free infrastructure is one Oracle Cloud A1
Always-Free VM (ARM, 24 GB RAM) that already hosts GunVest, plus GunVest's PostgreSQL and its
Cloudflare tunnel. Legion must co-exist with GunVest on that box and reach GunVest's database
and API, which are **not** published to the host.

## Decision

Deploy every Legion process as Docker Compose services on the one VM (NATS, one Ollama
container, orchestrator, four agents, risk, emitter, API, web, and the reliability/summary
cron runners). A dedicated [`docker-compose.prod.yml`](../../docker-compose.prod.yml) names all
containers `legion-*` and **joins GunVest's Docker network**, so Legion reaches `gunvest-db`
and `gunvest-app` by name (GunVest's Postgres binds only `127.0.0.1`, so the host gateway
cannot reach it — sharing the network is required, not optional). The web container is the sole
ingress, attached to the shared `tunnel-gateway` network and exposed via GunVest's cloudflared;
because `vite preview` does not proxy `/api`, the proxy target is env-driven
(`LEGION_API_PROXY`). CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) gates
on lint + migrate + tests, then deploys via manual `workflow_dispatch` over SSH.

## Alternatives considered

- **`host.docker.internal` to reach GunVest** — fails because GunVest's DB is bound to
  loopback inside its own network; only network-sharing exposes it by service name.
- **A second VM / managed Postgres** — defeats the ≈$0 goal.
- **Auto-deploy on green main** — deferred; deploy is manual `workflow_dispatch` (a one-line
  `if:` flips it to automatic) to keep a human in the loop for an advisory financial tool.

## Consequences

- Zero incremental infrastructure cost; one source of truth for data (GunVest).
- Single VM is a single point of failure; acceptable because output is advisory-only.
- Serial Ollama (ADR 0005) makes a sweep take tens of minutes — fine on a 4 h cadence.
- **Known gap:** the cron runners (`reliability`, `summary`) are defined in
  `docker-compose.yml` but not yet in `docker-compose.prod.yml`, so those jobs do not auto-run
  in production until added.
