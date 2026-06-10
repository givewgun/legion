# ADR 0028 — Roster Watch (flag chronically floored agents)

## Status

Accepted (2026-06-10).

## Context

The roster is static. An agent whose ρ sits at the 0.5 floor for months keeps consuming
an LLM call per ticker per round and keeps a (halved but real) voice in every aggregate —
and nothing ever surfaces "this voice has been wrong for a quarter" to the operator. The
opposite failure is worse: silent *auto*-retirement would let the system shrink its own
panel below the BFT floor (ADR 0001/§1.2) on noisy evidence.

## Decision

The reliability recompute tracks, per agent, a **floored streak** — consecutive
recomputes with `ρ ≤ 0.55` — and raises a **review flag** once the streak reaches 6
(~3 days at the 12h cadence). Recovery above the floor resets both. The flag and streak
are persisted on `agent_reliability`, surfaced on the leaderboard, and logged as a
warning. **The system never auto-retires**: a human acts on the flag (e.g. disable the
agent on the Agents tab, swap its model, or fix its feed).

## Alternatives considered

- **Auto-disable at the threshold** — couples a noisy statistic to panel size; degraded
  quorum (§1.2) shows exactly why shrinking the panel is not a decision to automate.
- **Flag on info factor or calibration instead** — those have their own discounts; the
  floor streak captures the one case (persistent anti-skill) where money is being lost,
  not merely information missing.

## Consequences

- A chronically wrong agent becomes a visible, datable operational fact instead of a
  quiet drag.
- One UPDATE per agent per recompute; no live-path change.
