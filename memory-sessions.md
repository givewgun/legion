# Session log

## 2026-06-11 — Portfolio page 500 + percent formatting

- Diagnosed `GET /api/portfolio` 500: GunVest returned 404 for
  `/api/market/SPY/candles?days=400` — the candles endpoint had never existed in
  GunVest (the phase-4 handover flagged it "unverified live"). `/api/reliability`
  was empty for the same reason: the resolver, backtest, and risk-vol checks were
  all silently failing on candle fetches. Fix was made on the GunVest side
  (endpoint contract: `{candles:[{date:'YYYY-MM-DD', close}]}`, ascending, must
  include SPY/QQQ, days up to 400, `[]` not 404 for no data).
- Useful: the API error handler returns `{error: err.message}` in the 500 body,
  so failures are diagnosable without server logs. The handler does not log
  server-side, and the web client discards the body — both still open gaps.
- `web/src/lib/format.js` `pct()` now takes a `digits` arg (default 0); the
  portfolio page renders returns/drawdown with 2 decimals so sub-1% values no
  longer flatten to 0%.
- Portfolio sim execution semantics: all fills are at the daily close, never
  intraday. Fixed a look-ahead bug where a signal emitted after the US close
  (scheduler runs 24/7) filled at that same day's already-printed close; such
  signals now roll to the next trading day's close (20:00 UTC EDT cutoff used
  year-round, conservative in winter).
