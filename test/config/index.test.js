import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.consensus).toEqual({
      thetaV: 0.75,
      quorum: 0.6667,
      maxRounds: 3,
      holdBand: 0.5,
      priorQuorum: 0.3333,
    });
    expect(cfg.gunvestApiUrl).toBe('http://localhost:3001');
    expect(cfg.natsUrl).toBe('nats://localhost:4222');
    expect(cfg.ollama).toEqual({
      url: 'http://localhost:11434',
      model: 'qwen2.5:7b-instruct',
      timeoutMs: 300000,
      maxConcurrent: 1,
    });
  });

  it('reads overrides from env and coerces numbers', () => {
    const cfg = loadConfig({
      CONSENSUS_THETA_V: '0.3',
      CONSENSUS_QUORUM: '0.75',
      CONSENSUS_MAX_ROUNDS: '5',
      CONSENSUS_HOLD_BAND: '0.4',
      CONSENSUS_PRIOR_QUORUM: '0.25',
      GUNVEST_API_URL: 'http://api:3001',
      NATS_URL: 'nats://bus:4222',
      OLLAMA_URL: 'http://ollama:11434',
      OLLAMA_MODEL: 'llama3.1:8b',
      OLLAMA_TIMEOUT_MS: '120000',
      OLLAMA_MAX_CONCURRENT: '2',
      DATABASE_URL: 'postgres://u:p@db:5432/gunvest',
    });
    expect(cfg.consensus).toEqual({
      thetaV: 0.3,
      quorum: 0.75,
      maxRounds: 5,
      holdBand: 0.4,
      priorQuorum: 0.25,
    });
    expect(cfg.gunvestApiUrl).toBe('http://api:3001');
    expect(cfg.natsUrl).toBe('nats://bus:4222');
    expect(cfg.ollama).toEqual({
      url: 'http://ollama:11434',
      model: 'llama3.1:8b',
      timeoutMs: 120000,
      maxConcurrent: 2,
    });
    expect(cfg.databaseUrl).toBe('postgres://u:p@db:5432/gunvest');
  });

  it('throws on a non-numeric threshold', () => {
    expect(() => loadConfig({ CONSENSUS_THETA_V: 'abc' })).toThrow(
      'CONSENSUS_THETA_V must be a number',
    );
  });
});
