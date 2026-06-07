# ADR 0011 — Risk Manager as a Deterministic, Non-Voting Constraint

## Status

Accepted (2026-06-04).

## Context

The consensus panel can produce a confident BUY into a market regime where any buy is unwise
(a volatility spike, an outsized daily gap). Risk management is fundamentally different from
opinion: it is a hard, rule-based guardrail, not another view to be averaged. Mixing it into
the vote would let it be out-voted, and would make a deterministic safety rule depend on an LLM.

## Decision

Model risk as a **deterministic, non-voting constraint node** that runs after the panel and can
only *tighten* the result, never create or flip a signal. The rule
([`src/risk/rules.js`](../../src/risk/rules.js), `computeConstraint`) is a pure function: VIX ≥
30 caps conviction at 0.5; VIX ≥ 40 additionally blocks new longs; an outsized daily move
(≥ 8%) caps conviction at 0.4; it returns the tightest applicable cap, a `blockBuy` flag, and a
human-readable reason. The node publishes a constraint on `legion.constraint.<TICKER>.<round>`;
the emitter applies it ([`src/risk/apply.js`](../../src/risk/apply.js)) when shaping the final
plan. It is toggleable via `LEGION_RISK_ENABLED`.

## Alternatives considered

- **Risk as a voting agent** — could be out-voted by the panel, defeating the point of a
  guardrail; explicitly rejected (promoting it to a vote is a documented future option behind a
  flag, not the default).
- **An LLM risk persona** — makes a safety constraint non-deterministic and unauditable.
- **Bake risk into each agent's prompt** — scatters the rule, makes it inconsistent, and loses
  the single auditable constraint record.

## Consequences

- The safety rail is deterministic, unit-testable, and auditable independent of any model.
- Risk can only reduce exposure (cap/block), never manufacture a trade.
- Adding a new rule is a pure-function edit with a test, no prompt engineering.
- If every voting agent were disabled, the emitter would still wait for votes — risk does not
  substitute for the panel.
