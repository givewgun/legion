# ADR 0017 — Recency-Decayed, Asymmetric Reliability

## Status

Accepted (2026-06-08). Refines ADR 0008.

## Context

ADR 0008 learns each agent's reliability `ρ` (and ADR 0014 its calibration) from a trailing
`WINDOW = 50` of resolved forecasts, equal-weighted, with a symmetric mapping
`ρ = clamp(1 + 2·(0.25 − meanBrier), 0.5, 1.5)`. Two properties of that scheme age badly:

1. **Equal weighting is slow.** A regime shift (an agent that was sharp last quarter and is now
   stale) only moves `ρ` once enough new forecasts dilute the old ones — and the 50th-oldest
   forecast counts exactly as much as yesterday's.
2. **Symmetry mis-prices risk.** Rewarding skill and punishing anti-skill at the same slope treats
   a dollar of avoided loss like a dollar of captured gain. Acting on a bad call costs capital;
   a falling forecaster should lose trust faster than a rising one gains it.

## Decision

- **Recency decay.** Within the window, weight each resolved forecast by `DECAY^age` with a
  `HALF_LIFE = 20` (a forecast 20 slots older than the newest counts half). `ρ` uses the
  decay-weighted mean Brier; calibration uses decay-weighted mean conviction for its hit/miss
  discrimination. The math lives in [`src/consensus/reliability.js`](../../src/consensus/reliability.js)
  (`decayWeights`, `weightedMean`); rows arrive newest-first from `getResolvedForecasts`.
- **Asymmetric mapping.** Keep the neutral point at the coin-flip Brier `0.25`, but split the slope:
  `ρ = clamp(1 + (edge ≥ 0 ? 2·edge : 4·edge), 0.5, 1.5)` where `edge = 0.25 − meanBrier`. A poor
  forecaster reaches the `0.5` floor at a Brier of `0.375`; a perfect one still reaches the `1.5`
  cap at `0`.

The clamp band, neutral point, and `MIN_RESOLVED` cold-start gate are unchanged, so the existing
boundary behaviour (perfect → 1.5, random → 1.0, floor at 0.5) is preserved.

## Alternatives considered

- **Shrink the equal-weight window** — cruder than a half-life; throws away still-useful older
  evidence abruptly instead of fading it.
- **Per-signal online (gradient) updates** — noisier and harder to reason about than a windowed
  decay recompute on a cron (the same reason ADR 0008 chose a batch recompute).
- **Keep symmetry** — simpler, but lets a now-unreliable agent coast near `ρ = 1` while it bleeds
  capital; the asymmetry is a deliberate loss-aversion prior.

## Consequences

- `ρ` and calibration track the _recent_ agent, not its lifetime average, and a deteriorating
  forecaster is demoted faster than an improving one is promoted.
- Cold-start behaviour is unchanged (neutral until `MIN_RESOLVED`), and a fully in-control,
  steady agent lands on the same `ρ` as before (uniform decay weights → simple mean).
- Graded outcomes and per-asset benchmarks (the other ideas in this area) were intentionally
  deferred: a graded outcome would break the binary hit/miss the calibration discriminator relies
  on, and per-asset benchmarks would undo ADR 0008's single-benchmark comparability — each
  deserves its own decision.
