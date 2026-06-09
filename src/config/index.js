function num(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`${key} must be a number`);
  return parsed;
}

export function loadConfig(env = process.env) {
  return {
    gunvestApiUrl: env.GUNVEST_API_URL || 'http://localhost:3001',
    finnhubApiKey: env.FINNHUB_API_KEY || '',
    natsUrl: env.NATS_URL || 'nats://localhost:4222',
    databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/gunvest',
    apiPort: num(env, 'LEGION_API_PORT', 8088),
    reliabilityCron: env.LEGION_RELIABILITY_CRON || '0 */12 * * *',
    horizonDays: num(env, 'LEGION_HORIZON_DAYS', 5),
    summaryCron: env.LEGION_SUMMARY_CRON || '0 */6 * * *',
    summaryWindowHours: num(env, 'LEGION_SUMMARY_WINDOW_HOURS', 6),
    ollama: {
      url: env.OLLAMA_URL || 'http://localhost:11434',
      model: env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
      timeoutMs: num(env, 'OLLAMA_TIMEOUT_MS', 300000),
      maxConcurrent: num(env, 'OLLAMA_MAX_CONCURRENT', 1),
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
    consensus: {
      thetaV: num(env, 'CONSENSUS_THETA_V', 0.75),
      quorum: num(env, 'CONSENSUS_QUORUM', 0.6667),
      maxRounds: num(env, 'CONSENSUS_MAX_ROUNDS', 3),
      holdBand: num(env, 'CONSENSUS_HOLD_BAND', 0.5),
      // Min independent (round-1) backing a revision-round consensus must retain,
      // or it is treated as herding rather than agreement (ADR 0016).
      priorQuorum: num(env, 'CONSENSUS_PRIOR_QUORUM', 0.3333),
    },
  };
}
