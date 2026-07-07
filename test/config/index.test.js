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
      minPanel: 3,
    });
    expect(cfg.gunvestApiUrl).toBe('http://localhost:3001');
    expect(cfg.natsUrl).toBe('nats://localhost:4222');
    expect(cfg.ollama).toEqual({
      url: 'http://localhost:11434',
      model: 'qwen3:1.7b',
      timeoutMs: 3600000,
      maxConcurrent: 1,
      think: null,
    });
    expect(cfg.gunvest).toEqual({
      timeoutMs: 15000,
      retries: 2,
      maxConcurrent: 6,
      macroTtlMs: 60000,
    });
    expect(cfg.emitter).toEqual({ staleEntryMs: 5400000 });
    expect(cfg.cronTimezone).toBe('America/New_York');
    expect(cfg.summaryCron).toBe('0 18 * * 1-5');
    expect(cfg.summaryWindowHours).toBe(24);
  });

  it('reads overrides from env and coerces numbers', () => {
    const cfg = loadConfig({
      LEGION_CRON_TZ: 'Asia/Bangkok',
      CONSENSUS_THETA_V: '0.3',
      CONSENSUS_QUORUM: '0.75',
      CONSENSUS_MAX_ROUNDS: '5',
      CONSENSUS_HOLD_BAND: '0.4',
      CONSENSUS_PRIOR_QUORUM: '0.25',
      CONSENSUS_MIN_PANEL: '2',
      GUNVEST_API_URL: 'http://api:3001',
      NATS_URL: 'nats://bus:4222',
      OLLAMA_URL: 'http://ollama:11434',
      OLLAMA_MODEL: 'llama3.1:8b',
      OLLAMA_TIMEOUT_MS: '120000',
      OLLAMA_MAX_CONCURRENT: '2',
      GUNVEST_TIMEOUT_MS: '20000',
      GUNVEST_RETRIES: '3',
      GUNVEST_MAX_CONCURRENT: '4',
      GUNVEST_MACRO_TTL_MS: '30000',
      LEGION_EMITTER_STALE_MS: '120000',
      DATABASE_URL: 'postgres://u:p@db:5432/gunvest',
    });
    expect(cfg.consensus).toEqual({
      thetaV: 0.3,
      quorum: 0.75,
      maxRounds: 5,
      holdBand: 0.4,
      priorQuorum: 0.25,
      minPanel: 2,
    });
    expect(cfg.gunvestApiUrl).toBe('http://api:3001');
    expect(cfg.natsUrl).toBe('nats://bus:4222');
    expect(cfg.ollama).toEqual({
      url: 'http://ollama:11434',
      model: 'llama3.1:8b',
      timeoutMs: 120000,
      maxConcurrent: 2,
      think: null,
    });
    expect(cfg.gunvest).toEqual({
      timeoutMs: 20000,
      retries: 3,
      maxConcurrent: 4,
      macroTtlMs: 30000,
    });
    expect(cfg.emitter).toEqual({ staleEntryMs: 120000 });
    expect(cfg.databaseUrl).toBe('postgres://u:p@db:5432/gunvest');
    expect(cfg.cronTimezone).toBe('Asia/Bangkok');
  });

  it('throws on a non-numeric threshold', () => {
    expect(() => loadConfig({ CONSENSUS_THETA_V: 'abc' })).toThrow(
      'CONSENSUS_THETA_V must be a number',
    );
  });

  it('parses OLLAMA_THINK as a tri-state boolean', () => {
    expect(loadConfig({ OLLAMA_THINK: 'false' }).ollama.think).toBe(false);
    expect(loadConfig({ OLLAMA_THINK: 'true' }).ollama.think).toBe(true);
    expect(loadConfig({}).ollama.think).toBeNull();
    // case-insensitive per the helper contract
    expect(loadConfig({ OLLAMA_THINK: 'TRUE' }).ollama.think).toBe(true);
    expect(loadConfig({ OLLAMA_THINK: 'False' }).ollama.think).toBe(false);
    // unrecognized values fall back to null (field omitted, qwen2.5-safe)
    expect(loadConfig({ OLLAMA_THINK: 'yes' }).ollama.think).toBeNull();
    expect(loadConfig({ OLLAMA_THINK: '' }).ollama.think).toBeNull();
  });

  it('defaults the home block to disabled (empty url) and qwen3:14b', () => {
    const cfg = loadConfig({});
    expect(cfg.home).toEqual({
      url: '',
      model: 'qwen3:8b',
      think: null,
      probeTimeoutMs: 1500,
      probeRetries: 3,
      probeRetryGapMs: 300,
      timeoutMs: 3600000,
      enabled: true,
      fallback: true,
    });
  });

  it('reads home overrides from env', () => {
    const cfg = loadConfig({
      HOME_OLLAMA_URL: 'http://100.64.0.2:11434',
      HOME_MODEL: 'qwen3:32b',
      HOME_THINK: 'false',
      HOME_PROBE_TIMEOUT_MS: '2000',
      HOME_TIMEOUT_MS: '600000',
    });
    expect(cfg.home).toEqual({
      url: 'http://100.64.0.2:11434',
      model: 'qwen3:32b',
      think: false,
      probeTimeoutMs: 2000,
      probeRetries: 3,
      probeRetryGapMs: 300,
      timeoutMs: 600000,
      enabled: true,
      fallback: true,
    });
  });

  it('reads HOME_FALLBACK=false to pin the PC (disable Oracle fallback)', () => {
    expect(loadConfig({ HOME_FALLBACK: 'false' }).home.fallback).toBe(false);
    expect(loadConfig({ HOME_FALLBACK: 'true' }).home.fallback).toBe(true);
    expect(loadConfig({}).home.fallback).toBe(true);
  });

  it('trading defaults (broker linkage itself lives in the DB — ADR 0036)', () => {
    const cfg = loadConfig({});
    expect(cfg.trading).toEqual({
      enabled: false, dryRun: true, minOrderNotional: 50, baseWeight: 0.05, maxPerName: 0.10,
      allowLive: false,
    });
    expect(cfg.broker).toBeUndefined();
  });

  it('trading env overrides', () => {
    const cfg = loadConfig({
      LEGION_TRADING_ENABLED: 'true', LEGION_TRADING_DRY_RUN: 'false',
      LEGION_TRADING_MIN_NOTIONAL: '100', LEGION_ALLOW_LIVE_BROKER: 'true',
    });
    expect(cfg.trading.enabled).toBe(true);
    expect(cfg.trading.dryRun).toBe(false);
    expect(cfg.trading.minOrderNotional).toBe(100);
    expect(cfg.trading.allowLive).toBe(true);
  });
});
