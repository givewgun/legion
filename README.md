# Legion

Distributed multi-agent stock signal gestalt. Independent expert agents vote on a ticker
and reach a leaderless, BFT-flavored consensus, delivered to Telegram and a dashboard.

Design: see `legion/docs/superpowers/specs/2026-06-04-legion-design.md`.

## Status

Phase 0 — Foundation. Ships shared libraries (consensus math, vote schema, config, DB
schema, NATS wrapper, LLM provider, GunVest client). No running agents yet.

## Prerequisites

- Node.js ≥ 18
- Docker (for NATS + Ollama)
- A running GunVest instance (REST API + PostgreSQL)

## Setup

```bash
cp .env.example .env       # edit values
npm install
docker compose up -d       # start NATS + Ollama
docker exec -it legion-ollama ollama pull qwen2.5:7b-instruct
npm run db:migrate         # create the legion schema in GunVest's Postgres
npm test
```

## Consensus tuning (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `CONSENSUS_THETA_V` | 0.5 | Max dispersion `V_r` for convergence |
| `CONSENSUS_QUORUM` | 0.6667 | Min directional quorum `κ_r` (2/3) |
| `CONSENSUS_MAX_ROUNDS` | 3 | Round cap before NO_CONSENSUS |
| `CONSENSUS_HOLD_BAND` | 0.5 | Neutral band half-width for `S_r` |
