# ADR 0034 — Vote-Drift Herding Telemetry

## Status

Accepted (2026-07-02).

## Context

The anti-herding guard (ADR 0016) gates a revision-round consensus on *independent backing*:
the converged side must trace back to a pre-dissent round-1 minority of at least `priorQuorum`.
That guard checks one thing — support for the **final** side — and is blind to a subtler
failure: the panel's **lean itself migrating** across rounds toward the loudest agent. A
consensus can pass the backing test (the final side held a thin-but-sufficient round-1
minority) while most of the panel abandoned its independent read along the way
(IMPROVEMENT-PLAN §2.3). If revision rounds routinely move stances without new evidence,
the debate is amplifying social pressure, not information — and today nothing measures it.

## Decision

Measure the movement; do not gate on it.

- `voteDrift(votes, priorVotes)` ([`src/consensus/aggregate.js`](../../src/consensus/aggregate.js))
  returns the aggregate stance movement since the independent priors:
  `Σ_i |s_i,r − s_i,1|` over the agents present in both rounds. Round 1 is 0 by
  construction; each flip contributes its full size (a −2 → +2 capitulation adds 4).
- The emitter computes drift for every aggregated round from the RAW round-1 votes it
  already retains for the herding guard (weight/conviction scaling never touches stance),
  and persists it on the round row (`legion.rounds.drift`).
- A converged signal carries the final round's drift on its plan (`plan.drift`), next to
  `agreement` — same measured-not-gated posture as IMPROVEMENT-PLAN §2.2.

Following the §2.2 discipline (instrument, then gate): whether high-drift consensus
underperforms is a question for the resolver data. Only if it does would a drift-aware
guard (e.g. requiring new evidence for large moves) become its own ADR.

## Alternatives considered

- **Gate immediately** (reject high-drift convergence) — no evidence yet that drift without
  new information predicts bad calls; gating on an unvalidated heuristic risks blocking
  genuine persuasion, the very thing multi-round debate exists to allow.
- **Per-agent drift columns** — richer, but the per-agent stances are already persisted per
  round in `legion.votes`; any per-agent breakdown is derivable after the fact. One scalar
  per round is the cheapest query surface for "which cycles smell herded".
- **Normalize by panel size** — comparability across rosters, but the roster is stable and
  the raw Σ matches the IMPROVEMENT-PLAN definition; normalization can happen in analysis.

## Consequences

- Every round row now records how far the panel moved from its independent priors; herded
  cycles become queryable (`ORDER BY drift DESC`) without replaying debates.
- The resolver data can answer whether high-drift converged signals underperform before any
  gate is added — the same instrument-first path agreement strength (§2.2) is on.
- No behavioral change: nothing reads drift yet, convergence math is untouched, and a fresh
  deploy behaves identically (cold-start neutrality preserved).
