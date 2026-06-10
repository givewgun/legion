# ADR 0027 — Learned Domain Priors (measured, not yet applied)

## Status

Accepted (2026-06-10). Measure-first: the prior is computed and surfaced; folding it into
weights is a future decision this data will inform.

## Context

The domain priors `w_i` (technical 1.0, news 1.2, social 0.8, contrarian 0.9) are
hand-set guesses at how load-bearing each lens is. ρ corrects for skill but is clamped to
[0.5, 1.5] *around* that fixed prior and recency-decayed — a badly-set `w_i` is only
half-correctable, forever. The data to fit `w_i` properly accumulates anyway; nothing was
reading it.

## Decision

On every reliability recompute, also compute each agent's **learned prior**: the same
graded skill score (ADR 0018) over a **long uniform window** (`LONG_WINDOW = 400`
resolved forecasts, no recency decay) — the standing skill that `w_i` is guessing at,
as distinct from ρ's "current form". Persist it
(`agent_reliability.learned_prior`) and surface it on the reliability leaderboard
(now also exposing calibration and the info factor).

**Deliberately not applied to weights yet.** ρ already multiplies `w_i`; folding in a
third skill-derived factor risks double-counting the same outcomes. The right blend
(e.g. `w_i ← w_i^(1−β) · learnedPrior^β` on a slow cron, heavy β shrinkage) should be
chosen by comparing the leaderboard's learned priors against the hand-set values once
real divergence is visible — the same instrument-then-act discipline as agreement
strength (§2.2).

## Alternatives considered

- **Apply immediately** — double-counts outcomes with ρ and changes live behaviour on
  zero observed divergence; rejected for now.
- **Fit w_i by regressing panel accuracy on leave-one-out weights** — the principled
  end-state, needs far more resolved volume.

## Consequences

- The dashboard can show, per agent, hand-set prior vs learned prior — the operator sees
  exactly when a guess has aged badly.
- One more column and one uniform-window pass per recompute; no live-path change.
