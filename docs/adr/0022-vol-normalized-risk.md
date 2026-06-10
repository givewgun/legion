# ADR 0022 — Vol-Normalized Risk Thresholds

## Status

Accepted (2026-06-10). Refines ADR 0011 (the constraint stays deterministic and LLM-free).

> **Plain-English walkthrough:** [How it works §8 — The Risk Manager](../HOW-IT-WORKS.md#8-the-risk-manager).

## Context

The outsized-move trip was a flat `|move| ≥ 8%`. An 8% day is a five-sigma event in a
low-vol utility (the brake should have fired long before) and routine noise in a meme
stock (the brake fires on a normal day). A risk rule that ignores how the *specific name*
trades mis-prices both tails.

## Decision

- The risk gatherer also fetches ~30 daily candles and computes the ticker's **realized
  daily sigma** (std-dev of daily log returns, in %) —
  [`dailySigmaPct`](../../src/risk/gather.js). The fetch degrades to `null` on failure;
  vol is an enhancement, never a new failure mode.
- [`computeConstraint`](../../src/risk/rules.js) trips the 0.4 conviction cap when
  `|move| ≥ 3 · dailySigmaPct` — a three-sigma day *for this name*. When sigma is
  unavailable, the original absolute 8% threshold applies unchanged.
- The VIX rules keep absolute levels (30/35/40 are regime constants the market itself
  quotes); a VIX-percentile variant needs a stored VIX history and is deferred.

## Alternatives considered

- **Keep the flat 8%** — simple, but systematically wrong in both tails (the motivating
  problem).
- **Reuse the Technical agent's indicator module** — couples a prompt-input module to the
  risk brake (the same coupling ADR 0009 rejected for the backtest); the sigma helper is
  ~10 lines and lives with its consumer.
- **VIX percentile over a trailing window** — better than absolute VIX in slow regime
  drifts, but requires persisting VIX history; deferred as its own decision.

## Consequences

- A 4% lurch in a quiet name now caps conviction (it is a 4σ event); an 8% day in a name
  with 4% daily vol no longer does (2σ is its normal weather).
- The constraint remains a pure function of its inputs — deterministic, no LLM, and the
  fallback keeps legacy behaviour bit-for-bit when vol data is missing.
