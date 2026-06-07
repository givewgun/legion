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
    ollama: {
      url: env.OLLAMA_URL || 'http://localhost:11434',
      model: env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
      timeoutMs: num(env, 'OLLAMA_TIMEOUT_MS', 300000),
      maxConcurrent: num(env, 'OLLAMA_MAX_CONCURRENT', 1),
    },
    consensus: {
      thetaV: num(env, 'CONSENSUS_THETA_V', 0.5),
      quorum: num(env, 'CONSENSUS_QUORUM', 0.6667),
      maxRounds: num(env, 'CONSENSUS_MAX_ROUNDS', 3),
      holdBand: num(env, 'CONSENSUS_HOLD_BAND', 0.5),
    },
  };
}
