# ADR 0004 — Single-VM Docker Deployment on Oracle A1

## Status

Accepted (2026-06-04).

## Context

The project targets ≈$0 runtime. Available free infra: an Oracle Cloud A1 Always-Free VM
(6 vCPU ARM, 24 GB RAM) and the GunVest PostgreSQL instance.

## Decision

Deploy everything as Docker Compose services on the one A1 VM: NATS, one Ollama container
(serial throughput), the orchestrator, voting agents, risk, emitter, API, web, and the
reliability/summary runners. Share GunVest's Postgres via an isolated `legion` schema; use
GunVest's REST API as the sole data source and its Telegram bot for delivery. The deterministic
backtest is a one-shot CLI, not a long-lived service.

## Consequences

- Zero incremental infra cost.
- Serial Ollama throughput → ~12–15 min/ticker cycle; fine for 6h batch cadence.
- Single VM is a single point of failure; advisory-only output makes this acceptable.
- Scaling to many tickers/agents later may require a second model server (deferred).
- GunVest stays the source of truth; Legion never re-implements data fetching.
