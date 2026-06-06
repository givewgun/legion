import { describe, it, expect } from 'vitest';
import { recomputeReliability } from '../../src/reliability/update.js';

describe('recomputeReliability', () => {
  it('rewards an agent whose confident calls resolved correctly', async () => {
    const forecasts = Array.from({ length: 6 }, () => ({
      agent_id: 'technical',
      stance: 2,
      conviction: 1,
      outcome: 1,
    }));
    const writes = [];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async (id, rho, n) => writes.push({ id, rho, n }),
    };
    const map = await recomputeReliability(repo);
    expect(map.technical).toBeCloseTo(1.5);
    expect(writes[0]).toMatchObject({ id: 'technical', n: 6 });
  });

  it('penalizes an agent whose confident calls resolved wrong', async () => {
    const forecasts = Array.from({ length: 6 }, () => ({
      agent_id: 'social',
      stance: 2,
      conviction: 1,
      outcome: 0,
    }));
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.social).toBeCloseTo(0.5);
  });

  it('keeps neutral 1.0 below MIN_RESOLVED sample', async () => {
    const forecasts = [
      { agent_id: 'news', stance: 2, conviction: 1, outcome: 1 },
      { agent_id: 'news', stance: 2, conviction: 1, outcome: 1 },
    ];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.news).toBe(1.0);
  });

  it('computes per-agent independently in one pass', async () => {
    const mk = (id, outcome) =>
      Array.from({ length: 5 }, () => ({ agent_id: id, stance: 2, conviction: 1, outcome }));
    const repo = {
      getResolvedForecasts: async () => [...mk('a', 1), ...mk('b', 0)],
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.a).toBeCloseTo(1.5);
    expect(map.b).toBeCloseTo(0.5);
  });
});
