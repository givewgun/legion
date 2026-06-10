# ADR 0025 — Outcome-Grounded Agent Memory

## Status

Accepted (2026-06-10). First mechanism that feeds outcomes back into agent *reasoning*
rather than aggregation weights.

> **Plain-English walkthrough:** [How it works §10 — Learning who to trust](../HOW-IT-WORKS.md#10-learning-who-to-trust).

## Context

Every learning mechanism so far (ρ, calibration, info factor, regime dials) turns
*volume knobs* on the mixer: an agent that keeps making the same mistake is made
quieter, but it keeps making the mistake — each cycle's prompt is amnesiac. The
gestalt's namesake improves by *reasoning better*, not only by being re-weighted.

## Decision

Before voting, each agent is shown its own **graded track record**, prepended to the
prompt as context:

- **Overall:** directional hit count over its last 20 resolved forecasts ("12 of 20
  directional calls beat SPY").
- **This ticker:** its last 3 resolved calls on the symbol, each with the stance,
  conviction, hit/missed verdict, and realized alpha vs SPY.

Mechanics ([`src/agents/memory.js`](../../src/agents/memory.js)):

- `repo.getAgentTrackRecord` reads the same resolved-forecast data the reliability loop
  grades — the memory is *verified outcomes*, never self-assessment;
- the factory fetches it via an optional `getMemory({ symbol })` callback, best-effort
  (a memory failure logs a warning and the agent votes without it — memory must never
  block a vote);
- empty record ⇒ empty block ⇒ the prompt is byte-identical to today (cold-start parity
  with every other mechanism);
- the block is **prepended** (context before task) so the response-contract spec stays
  last in the prompt.

## Alternatives considered

- **Similarity-retrieved episodes (k nearest past situations by indicator profile)** —
  the stronger version; needs an embedding/feature store and a similarity metric.
  Same-symbol recency is the honest first approximation and the schema it needs already
  exists.
- **Per-agent self-assessment journals (LLM-written post-mortems)** — drifts from
  ground truth; graded outcomes can't be confabulated.
- **Putting memory in the system prompt** — system prompts define the persona and stay
  static; the record is per-cycle context.

## Consequences

- An agent that was confidently wrong on this ticker's last three calls now *sees that*
  while forming today's conviction — few-shot self-correction with real ground truth.
- Adds two small indexed queries per agent per cycle round.
- Effectiveness is measurable with the existing yardsticks: compare ρ trajectories and
  hit rates before/after enabling memory (it can be disabled by not wiring `getMemory`).
