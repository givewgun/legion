# ADR 0009 — Self-Evaluation: Forward Paper-Test + Deterministic Backtest

## Status

Accepted (2026-06-04); implemented Phase 4 (2026-06-06).

## Context

Reliability weighting (ADR 0008) needs ground-truth outcomes, and operators need to know
whether the gestalt actually adds value. Replaying historical *LLM* debates is non-deterministic
and expensive (re-running every agent on past data), so it cannot be the evaluation backbone.

## Decision

Two complementary, deterministic evaluation paths:

1. **Forward paper-test.** When a signal is emitted, snapshot its entry price, horizon, and
   per-agent forecasts. After `horizonDays`, a resolver
   ([`src/reliability/resolver.js`](../../src/reliability/resolver.js)) computes the forward
   return and the SPY/QQQ returns over the same window; `outcome = forwardReturn > spyReturn`
   (alpha vs SPY), and `correct` records direction vs that excess. These resolved outcomes feed
   the Brier loop. This measures the *live* gestalt, no replay.

2. **Deterministic LLM-free backtest.** A pure engine
   ([`src/backtest/deterministic.js`](../../src/backtest/deterministic.js)) runs a transparent
   quant rule over historical candles and reports trades/hits/hit-rate/PnL vs SPY and QQQ, as a
   one-shot CLI. Its indicators ([`src/backtest/indicators.js`](../../src/backtest/indicators.js))
   are intentionally **separate** from the Technical agent's prompt indicators — different
   consumers, no coupling. The quant stance rule is trend-led: an SMA cross sets the side, a
   confirming MACD escalates to ±2, and an RSI extreme only *de-escalates* an over-extended
   reading (it never flips the side — an earlier additive rule wrongly flipped clear uptrends
   into losing shorts).

## Alternatives considered

- **LLM debate replay** — non-deterministic, slow, and would re-bill inference; rejected as the
  backbone.
- **Absolute return as the outcome** — rewards a rising tide; benchmarking against SPY isolates
  whether the call added *alpha*.
- **Sharing indicators with the Technical agent** — couples an LLM prompt input to a scoring
  engine that should be able to evolve independently.

## Consequences

- Both the learning signal (paper-test) and the sanity check (backtest) are reproducible.
- Backtest results populate immediately (historical), so the dashboard shows value before any
  live signal resolves; `ρ` only moves after signals age past the horizon.
- No de-duplication if a ticker is evaluated twice within one horizon window — each emitted
  signal is scored independently (accepted at low volume).
