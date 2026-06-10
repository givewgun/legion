# ADR 0020 — Effective-Voices Redundancy Discount

## Status

Accepted (2026-06-10). Replaces the per-vote correlation-mass heuristic of ADR 0015
(the correlation *source* — pairwise Pearson over co-rated signals — is unchanged).

> **Plain-English walkthrough:** [How it works §7 — Three honesty guards](../HOW-IT-WORKS.md#7-three-honesty-guards) (the redundancy discount).

## Context

ADR 0015 discounted each agreeing vote by `1 + Σ max(0, corr)` over the coalition. The
shape was right (echoes aren't extra evidence) but the denominator was ad hoc: each member
discounted against *all* others — including ones already discounted — so it was not an
effective-sample-size and over-penalized partial correlation (three agents at pairwise 0.5
collapsed to 1.5 voices, where the principled answer is 2).

## Decision

Scale the agreeing coalition's weight by **`N_eff / n`**, where `N_eff` is the
**participation ratio** of the coalition's correlation-matrix eigenvalues:

```
N_eff = (Σλ)² / Σλ²  =  n² / ‖R‖²_F  =  n² / Σᵢⱼ r²ᵢⱼ      (R symmetric, rᵢᵢ = 1)
```

No eigendecomposition is needed — the Frobenius norm computes it directly
([`effectiveVoices`](../../src/consensus/aggregate.js)). Negative correlation is clamped to
0 (hedging is not redundancy). Properties:

- all independent → `N_eff = n` → no discount (an unconfigured panel is unchanged);
- k perfect echoes → `N_eff = 1` → the coalition counts once (same as ADR 0015's worked case);
- partial correlation interpolates *correctly*: three agents at pairwise 0.5 → `N_eff = 2`.

## Alternatives considered

- **Keep the per-vote mass heuristic** — over-discounts (double-counts shared correlation)
  and has no statistical interpretation to reason about when tuning.
- **True eigen-decomposition with Ledoit–Wolf shrinkage of R** — the participation ratio
  via Frobenius is the same number; shrinkage of the *correlations* already happens at the
  source (pairs below `MIN_CORR_PAIRS` read 0).
- **Discount dispersion V as well** — correlated disagreement is rarer and gating κ is
  where echo-gaming bites; deferred.

## Consequences

- κ's discount is now an effective-sample-size statement: "this coalition speaks with
  `N_eff` independent voices out of `n`."
- Slightly *less* aggressive than ADR 0015 on partially-correlated coalitions (2 voices
  instead of 1.5 in the worked case) — the heuristic's over-penalty was unearned.
- One known gap remains and is tracked separately: a zero-variance (constant) voter has
  undefined Pearson correlation and reads as independent at the source; the information
  check (IMPROVEMENT-PLAN §3.6) addresses it on the conviction side.
