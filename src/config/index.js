function num(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

// Tri-state boolean: only the literal strings "true"/"false" (any case) are
// recognized; unset/empty/anything else -> null (caller-specific "don't send this").
function bool(env, key) {
  const raw = env[key];
  if (raw === undefined) return null;
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return null;
}

export function loadConfig(env = process.env) {
  return {
    gunvestApiUrl: env.GUNVEST_API_URL || 'http://localhost:3001',
    finnhubApiKey: env.FINNHUB_API_KEY || '',
    natsUrl: env.NATS_URL || 'nats://localhost:4222',
    databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/gunvest',
    apiPort: num(env, 'LEGION_API_PORT', 8088),
    reliabilityCron: env.LEGION_RELIABILITY_CRON || '0 */12 * * *',
    // Meta-reflection (ADR 0026): distill each agent's recent misses into a
    // lesson on the reliability cron. Off by default — it puts an LLM in the cron.
    reflectionEnabled: env.LEGION_REFLECTION === 'true',
    horizonDays: num(env, 'LEGION_HORIZON_DAYS', 5),
    // Market-aware cadence (ADR 0029): cron expressions are evaluated in this
    // IANA timezone, NOT the container's TZ (prod runs Asia/Bangkok). Anchoring
    // to the exchange's zone keeps "post-close" meaning post-close across DST
    // and avoids the BKK day-of-week skew (Friday's US close is Saturday ICT).
    cronTimezone: env.LEGION_CRON_TZ || 'America/New_York',
    // One digest per US trading day, after the post-close sweep, covering the
    // full 24h window — a digest cadence faster than the sweep cadence only
    // produces "No signals this window" Telegram noise (ADR 0029).
    summaryCron: env.LEGION_SUMMARY_CRON || '0 18 * * 1-5',
    summaryWindowHours: num(env, 'LEGION_SUMMARY_WINDOW_HOURS', 24),
    ollama: {
      url: env.OLLAMA_URL || 'http://localhost:11434',
      // In the standard tiered deploy this Ollama is the Oracle FALLBACK tier — a
      // CPU-only VM that only serves when the home PC primary is unavailable. A 7B
      // model on CPU under a multi-agent sweep can't finish inside OLLAMA_TIMEOUT_MS
      // and every call hangs the full timeout, so the fallback default is a small,
      // CPU-fast model. Override OLLAMA_MODEL (or the oracle_model runtime knob) when
      // this box has a GPU / is the sole tier.
      model: env.OLLAMA_MODEL || 'qwen2.5:3b-instruct',
      timeoutMs: num(env, 'OLLAMA_TIMEOUT_MS', 300000),
      maxConcurrent: num(env, 'OLLAMA_MAX_CONCURRENT', 1),
      // qwen3 emits <think>...</think> reasoning by default; qwen2.5 has no
      // thinking mode and doesn't understand the `think` field at all. null
      // means "omit the field entirely" so qwen2.5 deploys see an unchanged
      // request body — only set OLLAMA_THINK when running a qwen3-family model.
      think: bool(env, 'OLLAMA_THINK'),
    },
    // OpenAI-compatible provider families. An empty apiKey means the provider is
    // unconfigured: constructing it throws a clear error, and an agent assigned
    // to it abstains for that cycle rather than crashing.
    openai: {
      url: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY || '',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      timeoutMs: num(env, 'OPENAI_TIMEOUT_MS', 120000),
      maxConcurrent: num(env, 'OPENAI_MAX_CONCURRENT', 2),
    },
    gemini: {
      url: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
      timeoutMs: num(env, 'GEMINI_TIMEOUT_MS', 120000),
      maxConcurrent: num(env, 'GEMINI_MAX_CONCURRENT', 2),
    },
    // Home PC model server (the tiered `local` primary tier). An empty url means
    // unconfigured: the `local` provider stays pure-Oracle, byte-identical to before.
    // `enabled` is the static default; the dashboard toggle (runtime_config) overrides
    // it per cycle. `probeTimeoutMs` bounds the readiness-sidecar health probe so a
    // sleeping PC fails fast to Oracle instead of hanging the cycle.
    home: {
      url: env.HOME_OLLAMA_URL || '',
      // qwen3:8b — a capable reasoning ("thinking") model (~5 GB) that leaves plenty
      // of the 16 GB card free for OLLAMA_NUM_PARALLEL slots, so the home PC serves
      // several agents at once and finishes a sweep far faster than the larger 14b/20b.
      model: env.HOME_MODEL || 'qwen3:8b',
      think: bool(env, 'HOME_THINK'),
      probeTimeoutMs: num(env, 'HOME_PROBE_TIMEOUT_MS', 1500),
      // The PC is the preferred tier, so an inconclusive readiness probe (a cold
      // Tailscale hop that times out, a transient network blip) is retried before
      // giving up to the slow Oracle — a single miss must not divert a whole sweep.
      // A definitive ready:false (the operator is gaming) is NOT retried.
      probeRetries: num(env, 'HOME_PROBE_RETRIES', 3),
      probeRetryGapMs: num(env, 'HOME_PROBE_RETRY_GAP_MS', 300),
      // PC-preferred routing commits to the PC and queues rather than failing over,
      // so a call may wait behind the NUM_PARALLEL slots on a big sweep. Give it a
      // generous deadline (60 min) so a deep queue completes instead of aborting into
      // an abstain. The emitter's 90-min stale window resets on each arriving vote, so
      // a steady trickle keeps the round alive even past any single call's wait.
      timeoutMs: num(env, 'HOME_TIMEOUT_MS', 3600000),
      enabled: true,
      // Tiering switch. Default true = probe-gated Oracle fallback when the PC is
      // unavailable. Set HOME_FALLBACK=false to PIN the PC: every cycle runs on the
      // home PC and never spills to the slow Oracle VM (a PC error abstains instead).
      fallback: bool(env, 'HOME_FALLBACK') !== false,
    },
    // Resilience knobs for the GunVest read client. Defaults live in
    // src/data/gunvest.js; these env overrides let operators raise the timeout or
    // throttle concurrency when a sweep bursts the single-threaded API.
    gunvest: {
      timeoutMs: num(env, 'GUNVEST_TIMEOUT_MS', 15000),
      retries: num(env, 'GUNVEST_RETRIES', 2),
      maxConcurrent: num(env, 'GUNVEST_MAX_CONCURRENT', 6),
      macroTtlMs: num(env, 'GUNVEST_MACRO_TTL_MS', 60000),
    },
    // Emitter buffers per-(cycle,round) vote state; entries silent longer than
    // this are swept (and their cycle closed as 'timeout') so a missing agent /
    // constraint can't leak them forever. 90 min: a growing ticker batch drains
    // through a serial ollama queue, so one round's votes can legitimately
    // trickle in for over an hour.
    emitter: {
      staleEntryMs: num(env, 'LEGION_EMITTER_STALE_MS', 5400000),
    },
    consensus: {
      thetaV: num(env, 'CONSENSUS_THETA_V', 0.75),
      quorum: num(env, 'CONSENSUS_QUORUM', 0.6667),
      maxRounds: num(env, 'CONSENSUS_MAX_ROUNDS', 3),
      holdBand: num(env, 'CONSENSUS_HOLD_BAND', 0.5),
      // Min independent (round-1) backing a revision-round consensus must retain,
      // or it is treated as herding rather than agreement (ADR 0016).
      priorQuorum: num(env, 'CONSENSUS_PRIOR_QUORUM', 0.3333),
      // Effective-panel floor: rounds with fewer weight-carrying votes are tagged
      // degraded — the single-outlier tolerance of ADR 0001 no longer holds.
      minPanel: num(env, 'CONSENSUS_MIN_PANEL', 3),
    },
    // Multi-tenant web auth (ADR 0030). allowedEmails gates who can create a
    // session; empty array = nobody can log in (fail closed).
    auth: {
      googleClientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
      googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      sessionSecret: env.SESSION_SECRET || '',
      publicUrl: env.LEGION_PUBLIC_URL || 'http://localhost:5174',
      allowedEmails: (env.LEGION_ALLOWED_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    },
  };
}
