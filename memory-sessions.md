# Session log

## 2026-07-02 — Oracle defaults to a thinking model (qwen3:4b, think=true)

- Second PR on top of the ADR 0033 thought-sharing feature (PR #67, merged): switched the
  Oracle tier's default model to `qwen3:4b` and turned the think knob on in `.env.example`
  and the deploy job (`MODEL=qwen3:4b`, `OLLAMA_THINK=true`, `OLLAMA_TIMEOUT_MS` 300s→900s).
  Updated README/RUNNING pull commands, prod compose mem comment, config default + test.
- User intent: the Oracle VM should run a model "that can think", not too large.

## 2026-07-02 — Thinking agents: share the reasoning, not just the vote (ADR 0033)

- Providers now return `{ text, thinking }` (Ollama structured thinking, OpenAI-compat
  `reasoning_content`; tiered passes it through with model/source; `normalizeGenerate`
  absorbs all shapes; moat scorer switched to `normalizeGenerate`).
- Votes carry an optional `thought`: the runner uses structured thinking, falls back to
  splitting inline `<think>…</think>` blocks out of the answer, caps at 6000 chars.
  Persisted on `legion.votes.thought`, restored through emitter crash recovery.
- `summarizePeers` quotes each peer's thought (indented, 900-char cap) under its dissent
  line — revision rounds argue with the peer's actual logic. No thought → byte-identical
  prompt to before.
- New `oracle_think` runtime knob (tribool → `ollama.think`) so the Oracle VM can run a
  thinking model from the dashboard; dashboard debate viewer shows a collapsed
  "Show reasoning" block per vote.
- User context: wants to run a thinking model on the Oracle VM specifically so the
  thought-sharing consensus works there too.

## 2026-07-02 — Oracle fallback timeouts, reliability board dedupe, ops buttons

- Root-caused `abstain (data fetch failed: Ollama request timed out after 3600000ms)`
  on every Oracle fail-over: the ollama-js client awaits response headers before the
  provider's abort timer starts, so queued calls on the saturated CPU box were killed at
  undici's default 300s `headersTimeout` — raising `OLLAMA_TIMEOUT_MS` (PR #65) never
  touched that phase, and `wrapError` mislabeled the abort with the full 60-min deadline.
  Fixed by handing the client an undici fetch whose dispatcher timeouts equal `timeoutMs`.
- Fixed a second fail-over breaker: `withModel` leaked the per-agent PC model onto
  `cfg.ollama.model` when the home-PC toggle was off, making VM-only runs load a PC-sized
  model on the CPU Oracle. Per-agent 'local' models now always target `cfg.home` when a
  PC is configured.
- Reliability board showed duplicate agent names: dials are per (agent, model) but the
  perf summaries and UI were per agent. Segmented `summarizeAgents` by `modelKey`, added
  `model` to `/api/reliability` rows, UI shows the model under the agent name.
- Added PoC ops controls on the (login-gated) Config page: "Run all cycles"
  (existing `POST /api/trigger`) and "Relearn reliability" (new
  `POST /api/reliability/relearn`, running the cron's resolve+recompute pass on demand —
  `runReliabilityOnce` moved to `src/reliability/run-once.js`, re-exported from the runner).
- User context: runs the panel on the home PC normally, wants to run VM-only at times
  with the PC unplugged — Oracle fallback must be dependable.

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

## 2026-06-11 — Market-aware cron cadence (ADR 0029)

- Assessed cron granularity, concluded the 4h/24-7 sweep was noise-heavy, and
  shipped ADR 0029: market-hours-anchored sweep + once-daily digest,
  timezone-pinned to America/New_York via node-cron's `timezone` option (prod
  containers run `TZ=Asia/Bangkok`, where Friday's US post-close falls on
  Saturday ICT and a `1-5` weekday filter would drop it).
- Updated scheduler/summary runners, config (+`cronTimezone`), deploy workflow,
  `.env.example`, docs, and config tests. Full suite green (527 tests).
- Note for the portfolio sim's after-close roll (above): the new 17:00 ET
  post-close sweep makes after-close emission the norm — those signals correctly
  fill at the NEXT trading day's close.
