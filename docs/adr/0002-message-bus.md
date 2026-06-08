# ADR 0002 — NATS Message Bus with In-Memory Test Double

## Status

Accepted (2026-06-04).

> **Plain-English walkthrough:** [How it works §2 — The one cycle, start to finish](../HOW-IT-WORKS.md#2-the-one-cycle-start-to-finish).

## Context

The runtime is a set of independent processes — an orchestrator, four voting agents, a risk
node, and an emitter — that must communicate by topic, not by direct calls, so agents stay
decoupled and the vote stream is observable. They run on a single Always-Free VM, and the
whole orchestration must be testable without standing infrastructure.

## Decision

Use **NATS** as the runtime bus and define a thin `src/bus/` abstraction over it:
[`subjects.js`](../../src/bus/subjects.js) (the subject taxonomy), a NATS adapter
(`connectBus`), and [`memory.js`](../../src/bus/memory.js) — an in-memory bus implementing the
same `publishJSON`/`subscribeJSON` contract with NATS-style wildcard matching (`*` = one
token, `>` = one-or-more trailing tokens). Subjects are hierarchical:
`legion.cycle.<TICKER>`, `legion.vote.<TICKER>.<round>`, `legion.constraint.<TICKER>.<round>`,
`legion.consensus.<TICKER>`. Agents subscribe to the cycle wildcard; the emitter keys votes by
round. Integration tests run against the in-memory double; production wires NATS via the same
code paths.

## Alternatives considered

- **Redis pub/sub** — has channels but weaker wildcard semantics and would add a second role
  (it is not otherwise needed); NATS subject wildcards map directly onto the ticker/round
  hierarchy.
- **Kafka** — durable partitioned log, but heavy for a single 24 GB VM and overkill for
  fire-and-forget vote fan-out.
- **In-process function calls** — would couple the agents into one process and lose the
  leaderless, separately-deployable property.

## Consequences

- Infra-free, deterministic tests for orchestration, agents, and the emitter.
- One contract, two implementations — production behaviour is exercised by the same code.
- NATS adds one container; acceptable on the A1 VM.
- Risk: the memory double could drift from NATS semantics — mitigated by sharing the subject
  helpers and a wildcard-matching test suite.
