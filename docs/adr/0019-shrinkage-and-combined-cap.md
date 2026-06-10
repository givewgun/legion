# ADR 0019 — Evidence Shrinkage and a Combined Influence Cap

## Status

Accepted (2026-06-10). Refines ADR 0008/0014/0017/0018.

> **Plain-English walkthrough:** [How it works §10 — Learning who to trust](../HOW-IT-WORKS.md#10-learning-who-to-trust).

## Context

Two compounding risks in the learned dials:

1. **A clamp is a guard rail, not a prior.** ρ and calibration were estimated from the
   trailing window and only *clamped* to [0.5, 1.5] — so a `MIN_RESOLVED`-deep hot streak
   could legally pin an agent at the cap. The recency decay (ADR 0017) makes this *more*
   acute: a handful of recent wins dominates the weighted mean.
2. **The dials multiply.** ρ scales the prior and calibration scales conviction; together
   one agent's influence spans 0.25×–2.25×, a 9× spread driven by the *same* underlying
   outcomes (ADR 0014 concedes the overlap). In a trending regime a few correlated wins
   inflate both at once — single-agent dominance through the back door.

## Decision

- **Shrinkage toward neutral.** Every learned edge is scaled by `ess / (ess + SHRINK_K)`
  (`SHRINK_K = 10`) before it moves a dial, where `ess` is the **Kish effective sample
  size** `(Σw)²/Σw²` of the decay-weighted sample — the honest n once recency decay has
  concentrated mass on few rows. Applied to the ρ edge (`reliabilityFromBrier`) and the
  calibration discriminator (`calibrationFromSamples`) in
  [`src/consensus/reliability.js`](../../src/consensus/reliability.js). The clamp bands
  become asymptotic targets: only consistent evidence approaches them. (This is the
  standard Normal-shrinkage/empirical-Bayes form `n/(n+k)` with `k` playing the prior
  pseudo-count.)
- **Combined cap.** After both dials are computed, `boundCombined` bounds the product
  `ρ·cal` to **[0.4, 2.0]** by trimming **calibration only** — ρ stays the unmodified
  primary skill signal. Given ρ ∈ [0.5, 1.5], the trimmed calibration always lands back
  inside its own [0.5, 1.5] band.
- `MIN_RESOLVED`, the asymmetric slopes, the clamps, and cold-start neutrality are all
  unchanged; the anti-skill floor (0.5) remains reachable because the 4× down-slope
  saturates even shrunk edges.

## Alternatives considered

- **Full Beta-Binomial posterior on hit-rate** — more machinery for the same first-order
  effect; the `n/(n+k)` factor is the posterior-mean shrinkage in the conjugate case anyway.
- **Capping ρ·cal by trimming both proportionally** — muddies ρ as a pure skill readout
  for the leaderboard; trimming the secondary dial keeps both legible.
- **Tightening the individual clamp bands** — punishes well-evidenced agents to contain
  poorly-evidenced ones; shrinkage targets the actual problem (evidence depth).

## Consequences

- A 5-signal hot streak now moves an agent to ~1.19, not 1.5; reaching the extremes takes
  a consistent record across the window — exactly what "trust is earned" should mean.
- No agent's learned influence can exceed 2× (or fall below 0.4×) of its domain prior,
  regardless of how the two dials align.
- Boundary tests that asserted clamp values at thin samples were updated; floor behaviour
  for anti-skill is preserved.
