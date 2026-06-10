# ADR 0023 — Regime-Conditional Reliability

## Status

Accepted (2026-06-10). Extends ADR 0008/0014/0017/0018/0019.

> **Plain-English walkthrough:** [How it works §10 — Learning who to trust](../HOW-IT-WORKS.md#10-learning-who-to-trust).

## Context

ρ and calibration were single unconditional scalars per agent. But an agent's edge is
usually *conditional*: the Contrarian earns its keep at crowded extremes and burns weight
mid-range; Technical reads orderly tape better than panic. Collapsing that into one number
averages the edge away — "News is a 1.1× agent" when the truth is "News is 1.4× in
stressed tape and 0.8× in calm".

## Decision

- **Regime stamp at emit time.** The emitter classifies the cycle's regime from VIX
  ([`classifyRegime`](../../src/reliability/regime.js): `calm` < 20 ≤ `stressed`;
  `unknown` when VIX is unavailable) and stores it on the signal. Two coarse buckets are
  deliberate: per-bucket samples must stay dense enough to clear `MIN_RESOLVED` and beat
  the shrinkage (ADR 0019).
- **Per-regime dials.** The reliability cron reruns the same dial machinery (graded
  outcomes, skill-score baseline, shrinkage, combined cap) over each regime's slice of
  the window and persists per-(agent, regime) rows — **only for buckets with ≥
  `MIN_RESOLVED` rows**. Thin buckets are skipped, not stored as neutral.
- **Overlay at cycle time.** The emitter detects the current regime and overlays the
  regime dials over the unconditional ones per agent; agents without a deep regime
  bucket, and cycles with `unknown` regime, fall back to the unconditional dials. The
  information factor (ADR 0021) stays global — "is anyone home" is not regime-specific.

## Alternatives considered

- **Finer regimes (VIX tertile × SPY-trend sign)** — better conditioning but 6 buckets
  starves every one of them at Legion's signal volume; revisit when volume justifies it.
- **Per-asset benchmarks in the same change** — also regime-flavored, but it changes
  *outcome* semantics (ADR 0008's single-benchmark comparability) rather than dial
  selection; deliberately deferred as its own decision.
- **Continuous conditioning (regress edge on VIX)** — strictly more information, far less
  legible, and fragile at this sample size.

## Consequences

- The panel can trust different voices in different weather while every cold-start and
  fallback path behaves exactly as before (unknown regime ⇒ prior behaviour bit-for-bit).
- Regime rows lag the regime stamp by one resolution horizon, like every learned dial.
- Legacy signals (no regime column) feed only the unconditional dials.
