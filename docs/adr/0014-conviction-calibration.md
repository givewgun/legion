# ADR 0014 — Conviction Calibration (does confidence predict being right?)

## Status

Accepted (2026-06-08).

## Context

The aggregator (ADR 0001) weights every vote by `W_i · c_i`, where `c_i ∈ [0,1]` is the
agent's **self-reported** conviction. Reliability weighting (ADR 0008) learns a skill factor
`ρ_i` from outcomes, but `ρ_i` scales only the static prior `w_i` — conviction is taken at
face value. So an agent can inflate its influence simply by always shouting `c = 1`, and a
confident-but-uninformative voice drags the weighted mean and the dispersion gate until enough
of its forecasts resolve. Nothing in the loop asks the sharper question: _when this agent is
confident, is it actually more likely to be right?_

## Decision

Learn a second per-agent factor, **calibration** `cal_i`, that scales the _conviction_ term
(not the prior), and fold it in alongside `ρ_i`. The math lives in
[`src/consensus/reliability.js`](../../src/consensus/reliability.js):

- a resolved forecast is a **directional hit** when its side matched the benchmark —
  `directionalHit = outcome` for a bullish call, `1 − outcome` for a bearish one; HOLD makes no
  directional claim and is excluded;
- **discrimination** `d = meanConviction(hits) − meanConviction(misses) ∈ [-1, 1]` — positive
  when the agent is more confident on the calls it gets right;
- `cal = clamp(1 + d, 0.5, 1.5)` — neutral at `1.0`, bounded like `ρ`;
- `cal` stays neutral until the agent has **both** a hit and a miss across at least
  `MIN_RESOLVED = 5` directional forecasts over the trailing `WINDOW = 50` (discrimination is
  undefined without both classes).

The Brier loop ([`src/reliability/update.js`](../../src/reliability/update.js)) computes `cal`
in the same pass as `ρ` and persists it; the emitter applies `scaleWeights` (ρ → `w_i`) then
`scaleConviction` (cal → `c_i`) before every aggregation. The persisted **round record** stores
these effective inputs so any node recomputes the same `S/V/κ` (ADR 0001's verifiability), while
the **forecast snapshot** that feeds the learner keeps the **raw** self-reported conviction —
calibrating the snapshot would feed the learner its own output and create a feedback loop.

## Alternatives considered

- **Concave conviction transform `c^γ`** — bounds outlier influence but bluntly dampens every
  agent equally, including the well-calibrated ones; learns nothing per agent.
- **Calibrate inside `ρ`** — `ρ` already mixes skill and calibration via Brier; reusing it for
  the conviction term double-applies the same number. Keeping `cal` as a separate statistic
  (resolution of conviction) applied to a separate term keeps the two signals legible.
- **Full Brier reliability/resolution decomposition per bucket** — more principled but noisier
  at low volume and harder to reason about than a two-class mean-conviction gap.

## Consequences

- A loud-but-uninformative agent (constant high conviction, `d ≈ 0`) gets no extra trust;
  a confidently-wrong one (`d < 0`) has its conviction attenuated toward the 0.5 floor.
- `ρ` and `cal` overlap conceptually (both reward discrimination) but act on different terms
  (`w_i` vs `c_i`) with bounded effect, so the interaction is capped at `0.5×–1.5×` each.
- Like `ρ`, `cal` is cold-start neutral: a fresh deploy behaves identically to an uncalibrated
  one until ≥5 directional forecasts with both a hit and a miss resolve per agent.
