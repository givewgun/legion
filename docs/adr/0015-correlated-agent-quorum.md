# ADR 0015 — Redundancy-Discounted Quorum (correlated agents)

## Status

Accepted (2026-06-08).

> **Plain-English walkthrough:** [How it works §7 — Three honesty guards](../HOW-IT-WORKS.md#7-three-honesty-guards) (the redundancy discount).

## Context

The consensus quorum `κ` (ADR 0001) is the weighted fraction of votes whose side agrees with the
aggregate; a round converges only when `κ ≥ quorum`. But `κ` treats every agreeing vote as an
**independent** confirmation. In practice the agents are not independent: in a momentum regime the
news, social, and technical agents often move together on the same catalyst, so three agreeing
votes can be three echoes of one signal. The panel's whole premise (ADR 0001) is that _diversity_
makes the consensus honest — yet nothing measured whether the agreement was diverse. Effective
independent agreement was being overstated, letting correlated clusters clear the quorum too easily.

## Decision

Learn each agent pair's historical vote **co-movement** and discount redundant agreement in `κ`.

- A loop ([`src/reliability/correlations.js`](../../src/reliability/correlations.js)) computes the
  Pearson correlation of each pair's stances over recent signals
  ([`src/consensus/correlation.js`](../../src/consensus/correlation.js)) and persists it to
  `agent_correlation`. A pair stays independent (correlation `0`) until it has co-rated at least
  `MIN_CORR_PAIRS = 5` signals — the same cold-start neutrality as `ρ`. The recompute **fully
  replaces** the stored set, so a pair that ages out of the recent window (drops below the
  minimum, goes zero-variance, or loses an agent) reverts to independent instead of lingering as
  a stale discount.
- The quorum ([`src/consensus/aggregate.js`](../../src/consensus/aggregate.js)) divides each
  agreeing vote by the correlation mass it shares with the rest of the agreeing coalition
  (`mass_i = 1 + Σ_{j≠i} max(0, corr(i,j))`), so `κ = Σ_{i∈agree} (W_i·c_i)/mass_i / Σ_all W_i·c_i`.
  `k` perfectly co-moving agents collapse toward **one** independent confirmation; uncorrelated or
  contrarian (negatively correlated) agreement is undiscounted. The default lookup is `0`, so an
  unconfigured/cold panel computes exactly the original `κ`.

The discount is applied to `κ` only — not `S` or `V`. `κ` measures the _breadth of independent
agreement_ the convergence gate cares about; the mean stance and dispersion remain faithful to the
votes actually cast.

## Alternatives considered

- **Global per-agent independence weight** (down-weight a correlated agent everywhere) — simpler,
  but it conflates "redundant" with "unreliable" and would shrink a correlated agent's influence
  even when it is right and alone; redundancy is a property of a _coalition_, not an agent.
- **In-cycle redundancy only** (compare rationales/stances within the current debate) — needs no
  history, but a single round is too little signal to tell an echo from independent agreement.
- **Correlated-error discounting** (correlate hits/misses, not stances) — a valid but different
  notion; "co-moved votes" matches the stated concern and needs no resolved outcomes.

## Consequences

- A cluster of echoing agents can no longer manufacture a quorum; honest, diverse agreement is
  required to converge, reinforcing ADR 0001's diversity premise.
- Like `ρ` and calibration, the effect is cold-start neutral and grows only as co-rated history
  accrues; a fresh deploy is unchanged.
- An extreme case (all agents perfectly correlated) drives `κ` low enough to block even unanimous
  agreement — intentional: if the panel is truly one voice, it has no independent confirmation to
  act on.
