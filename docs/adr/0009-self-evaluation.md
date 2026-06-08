# ADR 0009 — Self-Evaluation: Forward Paper-Test + Deterministic Backtest

## Status

Accepted (2026-06-04); implemented Phase 4 (2026-06-06).

> **Plain-English walkthrough:** [How it works §11 — Did the call work?](../HOW-IT-WORKS.md#11-did-the-call-work)
> and [§12 — The deterministic backtest](../HOW-IT-WORKS.md#12-the-deterministic-backtest).

## Context

Reliability weighting (ADR 0008) needs ground-truth outcomes, and operators need to know
whether the gestalt actually adds value. Replaying historical *LLM* debates is non-deterministic
and expensive (re-running every agent on past data), so it cannot be the evaluation backbone.

## Decision

Two complementary, deterministic evaluation paths:

1. **Forward paper-test.** When a signal is emitted, snapshot the entry prices of the stock
   **and** its SPY/QQQ benchmarks (all fetched in the same instant), the horizon, and the
   per-agent forecasts. After `horizonDays`, a resolver
   ([`src/reliability/resolver.js`](../../src/reliability/resolver.js)) computes each leg's
   return from its **captured entry price** to the horizon-end close, then
   `outcome = forwardReturn > spyReturn` (alpha vs SPY) and `correct` records direction vs that
   excess. These resolved outcomes feed the Brier loop. This measures the *live* gestalt, no
   replay.

   Measuring from the price captured at fire time — rather than the signal day's *close* — is
   what makes the test honest: a signal fired intraday "enters" at the price it actually saw, and
   the stock and its benchmarks share one "entered at signal time" base, so the alpha comparison
   is fair and immune to candle lag. The window **end** is pinned to the signal's fixed horizon
   (`resolve_after = created_at + horizonDays`), **not** the resolver's run time — a late cron
   must not stretch the holding period, or two signals on the same horizon would be scored over
   different elapsed times and their Brier scores would not be comparable. Signals emitted before
   benchmark entries were captured (or cycles where the entry fetch failed) fall back to a
   consistent close-to-close window.

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
- **Measuring from the signal-day close instead of the captured entry** — simpler (no benchmark
  entry capture), but it discards the more accurate live entry we already fetch, biases intraday
  signals against their own day's close, and silently shifts the base when the signal-day candle
  is missing at resolution time.
- **Sharing indicators with the Technical agent** — couples an LLM prompt input to a scoring
  engine that should be able to evolve independently.

## Consequences

- Both the learning signal (paper-test) and the sanity check (backtest) are reproducible.
- Backtest results populate immediately (historical), so the dashboard shows value before any
  live signal resolves; `ρ` only moves after signals age past the horizon.
- No de-duplication if a ticker is evaluated twice within one horizon window — each emitted
  signal is scored independently (accepted at low volume).
