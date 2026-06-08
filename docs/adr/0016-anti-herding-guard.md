# ADR 0016 — Anti-Herding Guard on Revision-Round Consensus

## Status

Accepted (2026-06-08).

> **Plain-English walkthrough:** [How it works §7 — Three honesty guards](../HOW-IT-WORKS.md#7-three-honesty-guards) (the anti-herding guard).

## Context

Consensus runs up to `R_max` rounds (ADR 0001); between rounds each agent is shown its peers'
dissent and may revise. That iteration is meant to surface new evidence — but it also opens the
door to **herding**: agents abandoning their independent read to match the loudest or most
numerous peer, so a round "converges" through social pressure rather than agreement. A consensus
manufactured that way is exactly what the leaderless, diverse-panel design (ADR 0001) is supposed
to avoid, and it is indistinguishable from genuine convergence if we only look at the final round.

## Decision

Require that a consensus reached in a **revision** round still rests on **independent** support.

- The emitter remembers the **first round's** votes for each cycle — the independent priors, cast
  before any dissent was shown.
- When a round `> 1` meets the normal convergence test, the emitter computes
  `independentBacking` ([`src/consensus/aggregate.js`](../../src/consensus/aggregate.js)) — the
  weighted fraction of those first-round votes whose side already matched the converged side.
- If that backing is below `priorQuorum` (default `1/3`, `CONSENSUS_PRIOR_QUORUM`), the convergence
  is rejected: the round is recorded as not converged and deliberation continues. If the cap is
  reached while still herding, the cycle ends as `NO_CONSENSUS` rather than emitting a herded call.

Round 1 is never gated — it _is_ the independent signal. The guard only asks that later agreement
trace back to a real, pre-dissent minority at least.

## Alternatives considered

- **Anchoring blend** (pull each revised vote back toward its round-1 stance) — distorts the very
  votes we persist and reason about, and hides rather than surfaces herding.
- **Annotate-only** (emit the signal but flag/derate it) — softer, but still emits a call the panel
  only reached under social pressure; gating is truer to "honestly agree to disagree."
- **No revision at all** — throws away the legitimate value of agents updating on genuine new
  argument; the guard keeps revision while bounding its failure mode.

## Consequences

- A late "everyone caved to the loudest agent" convergence no longer produces a signal; it needs a
  standing independent minority (≥ `priorQuorum`) to be honoured.
- Genuine persuasion still converges, as long as some agents held the eventual side independently.
- The bar is a tunable floor, not a veto: with `priorQuorum = 0` the guard is disabled and behaviour
  reverts to plain multi-round consensus.
