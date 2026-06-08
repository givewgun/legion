# ADR 0008 — Reliability-Weighted Consensus (Brier → ρ)

## Status

Accepted (2026-06-04); implemented Phase 4 (2026-06-06). Refined by ADR 0017 (recency decay +
asymmetric penalty) and complemented by ADR 0014 (conviction calibration).

## Context

Every agent enters with a static prior weight `w_i` (a guess at how load-bearing its domain
is). But guesses age: an agent that is consistently right should count for more, and one that
is consistently wrong for less. The gestalt needs to learn whom to trust from outcomes, not
opinions — without a human re-tuning weights.

## Decision

Score each agent's resolved forecasts with the **Brier score** and fold the result into an
effective weight `W_i = w_i · ρ_i` used by the aggregator (ADR 0001). The math lives in
[`src/consensus/reliability.js`](../../src/consensus/reliability.js):

- a vote becomes a probability `forecastProb = clamp(0.5 + s·c/4, 0, 1)`;
- `brier = (prob − outcome)²` where `outcome` is whether the call beat SPY (ADR 0009);
- `ρ = clamp(1 + 2·(0.25 − meanBrier), 0.5, 1.5)` — `0.25` is a coin-flip's Brier, so an
  agent better than chance gets `ρ > 1`, worse gets `ρ < 1`;
- `ρ` stays neutral at `1.0` until an agent has `MIN_RESOLVED = 5` resolved forecasts, over a
  trailing `WINDOW = 50`.

A Brier loop ([`src/reliability/update.js`](../../src/reliability/update.js)) recomputes `ρ`
per agent and persists it; the emitter loads the map and applies `scaleWeights` before every
aggregation. A fresh deploy therefore behaves identically to an unweighted one until forecasts
resolve.

## Alternatives considered

- **Static weights only** — never learns; the original Phase 0 behaviour, kept as the `ρ=1.0`
  default.
- **Accuracy / hit-rate** — ignores calibration (confidence); Brier rewards being both right
  _and_ appropriately confident, which is what conviction encodes.
- **Online gradient updates per signal** — noisier and harder to reason about than a windowed
  batch recompute on a cron.

## Consequences

- The panel self-tunes toward its better forecasters with a bounded effect (`ρ ∈ [0.5, 1.5]`).
- No movement until ≥5 resolved signals per agent — intentional cold-start neutrality.
- QQQ excess is stored for display but only SPY excess scores `outcome`, keeping one benchmark
  for the learning signal.
