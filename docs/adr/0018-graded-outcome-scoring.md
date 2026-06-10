# ADR 0018 — Magnitude-Aware (Graded) Outcome Scoring for ρ

## Status

Accepted (2026-06-10). Refines ADR 0008/0017; calibration (ADR 0014) is unchanged.

> **Plain-English walkthrough:** [How it works §10 — Learning who to trust](../HOW-IT-WORKS.md#10-learning-who-to-trust).

## Context

The resolver scored every signal with a binary outcome, `forwardReturn > spyReturn ? 1 : 0`.
Beating SPY by one basis point and by twenty percent were the *same* outcome; a near-miss and
a disaster were the *same* miss. With a 5-day horizon and a small per-agent sample, the binary
label is mostly noise, so ρ moved on thin evidence — the single biggest drag on how fast the
gestalt learns who to trust. ADR 0017 deferred graded outcomes because the calibration
discriminator genuinely needs two classes; that constraint is real but only binds *calibration*,
not ρ.

A naive graded swap also has a trap: with outcomes pulled toward 0.5, the Brier of an
uninformative p = 0.5 forecaster shrinks below the binary coin-flip reference of 0.25, so
scoring against a fixed 0.25 would make *everyone* look skilled.

## Decision

- **Graded outcome for ρ.** `gradedOutcome = 0.5 + 0.5·tanh(alpha / ALPHA_SCALE)` where
  `alpha = forwardReturn − spyReturn` and `ALPHA_SCALE = 0.05` (a ±5% alpha lands near
  0.88/0.12; basis-point noise stays near 0.5). Lives in
  [`src/consensus/reliability.js`](../../src/consensus/reliability.js).
- **Skill-score baseline.** ρ maps the **Brier skill score** against the uninformative
  p = 0.5 forecaster scored over the *same* (decay-weighted) outcomes:
  `edge = 0.25 · (1 − meanBrier / baselineBrier)`, then the existing asymmetric slopes and
  clamp (`ρ = clamp(1 + (edge ≥ 0 ? 2 : 4)·edge, 0.5, 1.5)`). With binary outcomes the
  baseline is exactly 0.25, so the formula reduces to the previous `0.25 − meanBrier` —
  fully backward compatible, including all boundary behaviour.
- **Calibration stays binary.** `directionalHit` still uses the binary `outcome`; the
  hit/miss conviction discriminator keeps its two classes.
- **Legacy fallback.** Rows resolved before `forward_return`/`spy_return` were captured
  fall back to the binary outcome (`gradedOutcome` returns null without both legs).
- `getResolvedForecasts` now selects `forward_return` and `spy_return`; no schema change
  (both columns already existed on `legion.signals`).

## Alternatives considered

- **Keep binary, weight each forecast by |alpha|** — re-weights the sample but still cannot
  distinguish a confident near-miss from a confident disaster within a weight class.
- **Score against a fixed 0.25 baseline with graded outcomes** — inflates everyone's skill
  when outcomes cluster near 0.5 (the trap above); rejected.
- **Vol-normalize alpha per ticker before grading** — more faithful across tickers, but
  needs realized vol stored at resolution time; deferred as a follow-up rather than blocking
  the magnitude fix.

## Consequences

- A confident call that wins big now earns more ρ than one that scraped by; a confident
  large miss costs more than a rounding-error miss — per-signal information content rises,
  so ρ becomes meaningful with fewer resolved signals.
- An uninformative forecaster sits at exactly ρ = 1 by construction, in both binary and
  graded regimes.
- `outcome` (binary) remains stored and continues to feed calibration and dashboard
  hit-rates; nothing downstream of the resolver changes shape.
