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
      upsertReliability: async (id, rho, n, calibration) =>
        writes.push({ id, rho, n, calibration }),
    };
    const map = await recomputeReliability(repo);
    expect(map.technical.rho).toBeCloseTo(1.5);
    // All hits, no misses -> conviction discrimination undefined -> neutral calibration.
    expect(map.technical.calibration).toBe(1.0);
    expect(writes[0]).toMatchObject({ id: 'technical', n: 6, calibration: 1.0 });
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
    expect(map.social.rho).toBeCloseTo(0.5);
    expect(map.social.calibration).toBe(1.0);
  });

  it('boosts calibration when conviction discriminates hits from misses', async () => {
    // Confident (0.9) when right, hedged (0.2) when wrong -> informative conviction.
    const forecasts = [
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'tech',
        stance: 2,
        conviction: 0.9,
        outcome: 1,
      })),
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'tech',
        stance: 2,
        conviction: 0.2,
        outcome: 0,
      })),
    ];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    // d = 0.9 - 0.2 = 0.7 -> calibration = 1 + 0.7 = 1.7, clamped to 1.5 cap.
    expect(map.tech.calibration).toBeCloseTo(1.5);
  });

  it('cuts calibration when conviction is anti-informative (confidently wrong)', async () => {
    const forecasts = [
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'social',
        stance: 2,
        conviction: 0.3,
        outcome: 1,
      })),
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'social',
        stance: 2,
        conviction: 0.9,
        outcome: 0,
      })),
    ];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    // d = 0.3 - 0.9 = -0.6 -> calibration = 1 - 0.6 = 0.4, clamped to 0.5 floor.
    expect(map.social.calibration).toBeCloseTo(0.5);
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
    expect(map.news.rho).toBe(1.0);
    expect(map.news.calibration).toBe(1.0);
  });

  it('weights recent forecasts more, so ordering of the same outcomes changes rho', async () => {
    // Moderate briers (won't saturate the clamp): stance 1, conviction 0.5 -> prob 0.625.
    const good = (id) => ({ agent_id: id, stance: 1, conviction: 0.5, outcome: 1 }); // brier 0.14
    const bad = (id) => ({ agent_id: id, stance: 1, conviction: 0.5, outcome: 0 }); // brier 0.39
    const five = (fn, id) => Array.from({ length: 5 }, () => fn(id));
    // Rows are newest-first. Same 5 good + 5 bad, only the recency order differs.
    const recentlyGood = [...five(good, 'a'), ...five(bad, 'a')];
    const recentlyBad = [...five(bad, 'b'), ...five(good, 'b')];
    const repo = {
      getResolvedForecasts: async () => [...recentlyGood, ...recentlyBad],
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.a.rho).toBeGreaterThan(map.b.rho); // recent good > recent bad
  });

  it('computes per-agent independently in one pass', async () => {
    const mk = (id, outcome) =>
      Array.from({ length: 5 }, () => ({ agent_id: id, stance: 2, conviction: 1, outcome }));
    const repo = {
      getResolvedForecasts: async () => [...mk('a', 1), ...mk('b', 0)],
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map.a.rho).toBeCloseTo(1.5);
    expect(map.b.rho).toBeCloseTo(0.5);
  });
});
