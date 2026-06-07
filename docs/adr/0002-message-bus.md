# ADR 0002 — NATS Message Bus with In-Memory Test Double

## Status

Accepted (2026-06-04).

## Context

Five agent processes plus orchestrator, risk, and emitter must communicate via pub/sub with
subject wildcards, run on a single Always-Free VM, and be testable without standing
infrastructure.

## Decision

Use NATS (lightweight, Docker, subject wildcards `*`/`>`) as the runtime bus. Define an
`src/bus/` abstraction (`subjects.js`, a NATS adapter, and `memory.js` — an in-memory bus
implementing the same `publish`/`subscribe` contract with NATS-style wildcard matching).
Integration tests run against the in-memory double; production wires NATS.

## Consequences

- Infra-free, deterministic tests for orchestration, agents, and the emitter.
- One contract, two implementations — production behavior is exercised by the same code paths.
- NATS adds one container; acceptable on the A1 VM.
- Risk: the memory double could drift from NATS semantics — mitigated by sharing the subject
  helpers and a wildcard-matching test suite.
