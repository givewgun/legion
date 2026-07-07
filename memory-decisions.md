# Decisions

- **2026-07-07 — Broker linkage is DB data, not env (ADR 0036).** `legion.broker_connections`
  holds every configured brokerage account (IBKR paper, Webull TH paper/live) with
  AES-256-GCM-encrypted credentials (key = SHA-256 of SESSION_SECRET); a partial unique
  index keeps ≤1 active, and `src/broker/manager.js` rebuilds the adapter when
  (id, updated_at) changes, so switching brokers is a dashboard act picked up on the next
  15s executor tick. `IBKR_GATEWAY_URL` is gone; `LEGION_ALLOW_LIVE_BROKER` survives as the
  single env safety gate — a paper=false connection refuses to build or activate without
  it, so the dashboard alone can never flip Legion onto real money. Webull TH adapter
  (`src/broker/webull.js`) signs each request (HMAC-SHA256, scheme from the official
  Python SDK) — no gateway container; client_order_id = `legion<intent id>` preserves the
  cOID dedupe/reconcile discipline of ADR 0035 unchanged.

- **2026-07-02 — Cycle stop + reliability reset are emitter/DB-owned operations.** Stop is
  publish-only from the API (`DELETE /api/trigger[/:symbol]` → `legion.stop.<SYM>`): the
  emitter drops the round buffers, closes running cycles as `stopped` (new status), frees
  pending rows, and keeps a stopped-cycle guard so an agent mid-LLM-call can't resurrect
  the round with a late vote. `POST /api/reliability/reset` wipes the dial tables AND
  `signal_votes` (the graded evidence) — otherwise the next relearn re-derives the old
  dials; signals/backtest history stay intact. UI confirms before resetting.

- **2026-07-02 — Oracle model downgraded again: qwen3:1.7b.** qwen3:4b with thinking hit
  even the 60-min deadline under a sweep on the 2-OCPU box (user report). qwen3:1.7b
  (~1.4GB) is the smallest thinking tag that still votes usably — the last rung before
  thinking has to come off the Oracle tier (blank OLLAMA_THINK + qwen2.5) or move to the
  home-PC tier entirely.

- **2026-07-02 — Oracle default model is qwen3:4b with thinking ON.** Follow-up to
  ADR 0033: the Oracle tier's default (`OLLAMA_MODEL` env default, `.env.example`, and the
  deploy job's pinned `MODEL`) moves from qwen2.5 to `qwen3:4b` (~2.6GB, fits the 2-OCPU/12GB
  free tier) with `OLLAMA_THINK=true`, so the VM-only panel produces and shares reasoning
  traces. Deploy `OLLAMA_TIMEOUT_MS` raised 300s→900s because thinking multiplies tokens per
  call on CPU. Blank `OLLAMA_THINK` stays the off-switch for non-thinking models (some qwen3
  tags ignore think:false). If `oracle_model`/`oracle_think` rows exist in runtime_config they
  override env and must be updated on the dashboard.

- **2026-07-02 — Agents share reasoning traces, not just verdicts (ADR 0033).** A vote
  carries an optional `thought` (the thinking model's trace: structured `thinking` field,
  or inline `<think>` blocks split from the answer). The dissent block quotes it truncated
  (900 chars/peer; 6000-char storage cap) so revision rounds argue with the peer's actual
  math. Consensus math and the reliability loop ignore it — replayability holds. Sharing
  is gated purely by presence: non-thinking panels are byte-identical. New `oracle_think`
  runtime knob mirrors `home_think` for running a thinking model on the Oracle VM.

- **2026-07-02 — Ollama HTTP timeouts must match the call deadline.** Raising
  `OLLAMA_TIMEOUT_MS` alone can never fix queue-wait aborts: the ollama-js client awaits
  response HEADERS before our abort timer exists, and a box whose `NUM_PARALLEL` slots are
  busy sends nothing while a request queues — so undici's default 300s `headersTimeout`
  killed every call queued >5 min (mislabeled with the full configured timeout by
  `wrapError`). The provider now passes the client a custom `undici` fetch whose
  dispatcher's `headersTimeout`/`bodyTimeout` equal the provider's `timeoutMs` (dispatchers
  cached per deadline — providers are rebuilt every cycle).
- **2026-07-02 — Per-agent 'local' models always target the home block when a PC is
  configured.** `withModel` previously applied the dashboard-chosen model to
  `cfg.ollama.model` whenever `home.enabled === false`, so toggling "Use home PC model" off
  (VM-only runs) handed the CPU-only Oracle a PC-sized model and every call timed out. The
  override now parks on the idle home block; Oracle always keeps `oracle_model`/env.
- **2026-07-02 — Reliability board is per (agent, model) end to end.** Perf summaries
  (`summarizeAgents`) are keyed by `modelKey(agent_id, model)` to match the dials, the API
  returns `model` on each row, and the UI shows the model under the agent name — one agent
  served by two models is two rows with independent records, not duplicates.

- **2026-06-11 — Market-aware cron cadence (ADR 0029).** The 4h/24-7 sweep cron was
  judged too granular: agents read daily candles, so most fires re-evaluated an unchanged
  bar and the overlapping 5-day signals corrupted reliability stats. New defaults:
  `LEGION_CRON=0 11,17 * * 1-5` and `LEGION_SUMMARY_CRON=0 18 * * 1-5` (24h window),
  evaluated in `LEGION_CRON_TZ=America/New_York` via node-cron's `timezone` option —
  explicitly NOT the container TZ, because prod runs `TZ=Asia/Bangkok` where Friday's US
  post-close falls on Saturday ICT. Full rationale: `docs/adr/0029-market-aware-cron.md`.
