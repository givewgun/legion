import { describe, it, expect } from 'vitest';
import { recomputeReliability } from '../../src/reliability/update.js';
import { modelKey } from '../../src/llm/provider.js';

// Default model used for tests that are not testing model-bucketing behaviour.
const M = 'test-model';

// Helper: build a map key for the default model + given agent.
const mk = (agentId) => modelKey(agentId, M);

describe('recomputeReliability', () => {
  it('rewards an agent whose confident calls resolved correctly', async () => {
    const forecasts = Array.from({ length: 6 }, () => ({
      agent_id: 'technical',
      model: M,
      stance: 2,
      conviction: 1,
      outcome: 1,
    }));
    const writes = [];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async (id, model, rho, n, calibration) =>
        writes.push({ id, model, rho, n, calibration }),
    };
    const map = await recomputeReliability(repo);
    // perfect record, but only 6 resolved -> shrinkage keeps it well off the 1.5 cap
    expect(map[mk('technical')].rho).toBeGreaterThan(1.15);
    expect(map[mk('technical')].rho).toBeLessThan(1.5);
    // All hits, no misses -> conviction discrimination undefined -> neutral calibration.
    expect(map[mk('technical')].calibration).toBe(1.0);
    expect(writes[0]).toMatchObject({ id: 'technical', model: M, n: 6, calibration: 1.0 });
  });

  it('penalizes an agent whose confident calls resolved wrong', async () => {
    const forecasts = Array.from({ length: 6 }, () => ({
      agent_id: 'social',
      model: M,
      stance: 2,
      conviction: 1,
      outcome: 0,
    }));
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    // anti-skill saturates the floor even after shrinkage (down-slope is 4x)
    expect(map[mk('social')].rho).toBeCloseTo(0.5);
    expect(map[mk('social')].calibration).toBe(1.0);
  });

  it('boosts calibration when conviction discriminates hits from misses', async () => {
    // Confident (0.9) when right, hedged (0.2) when wrong -> informative conviction.
    const forecasts = [
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'tech',
        model: M,
        stance: 2,
        conviction: 0.9,
        outcome: 1,
      })),
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'tech',
        model: M,
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
    // d = 0.9 - 0.2 = 0.7, shrunk by the 6-sample evidence (ADR 0019) -> ~1.26
    expect(map[mk('tech')].calibration).toBeGreaterThan(1.2);
    expect(map[mk('tech')].calibration).toBeLessThan(1.5);
  });

  it('cuts calibration when conviction is anti-informative (confidently wrong)', async () => {
    const forecasts = [
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'social',
        model: M,
        stance: 2,
        conviction: 0.3,
        outcome: 1,
      })),
      ...Array.from({ length: 3 }, () => ({
        agent_id: 'social',
        model: M,
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
    // d = 0.3 - 0.9 = -0.6, shrunk by the 6-sample evidence -> ~0.78, below neutral
    expect(map[mk('social')].calibration).toBeLessThan(0.85);
    expect(map[mk('social')].calibration).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps neutral 1.0 below MIN_RESOLVED sample', async () => {
    const forecasts = [
      { agent_id: 'news', model: M, stance: 2, conviction: 1, outcome: 1 },
      { agent_id: 'news', model: M, stance: 2, conviction: 1, outcome: 1 },
    ];
    const repo = {
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map[mk('news')].rho).toBe(1.0);
    expect(map[mk('news')].calibration).toBe(1.0);
  });

  it('learned prior ignores recency: same lifetime record, same prior (ADR 0027)', async () => {
    const good = (id) => ({ agent_id: id, model: M, stance: 1, conviction: 0.5, outcome: 1 });
    const bad = (id) => ({ agent_id: id, model: M, stance: 1, conviction: 0.5, outcome: 0 });
    const five = (fn, id) => Array.from({ length: 5 }, () => fn(id));
    const priors = [];
    const repo = {
      getResolvedForecasts: async () => [
        ...five(good, 'a'),
        ...five(bad, 'a'),
        ...five(bad, 'b'),
        ...five(good, 'b'),
      ],
      upsertReliability: async () => {},
      upsertLearnedPrior: async (id, model, prior) => priors.push({ id, model, prior }),
    };
    const map = await recomputeReliability(repo);
    // recency-weighted rho disagrees, but the uniform lifetime prior is identical
    expect(map[mk('a')].rho).not.toBeCloseTo(map[mk('b')].rho, 3);
    expect(map[mk('a')].learnedPrior).toBeCloseTo(map[mk('b')].learnedPrior, 10);
    expect(priors).toHaveLength(2);
  });

  it('weights recent forecasts more, so ordering of the same outcomes changes rho', async () => {
    // Moderate briers (won't saturate the clamp): stance 1, conviction 0.5 -> prob 0.625.
    const good = (id) => ({ agent_id: id, model: M, stance: 1, conviction: 0.5, outcome: 1 }); // brier 0.14
    const bad = (id) => ({ agent_id: id, model: M, stance: 1, conviction: 0.5, outcome: 0 }); // brier 0.39
    const five = (fn, id) => Array.from({ length: 5 }, () => fn(id));
    // Rows are newest-first. Same 5 good + 5 bad, only the recency order differs.
    const recentlyGood = [...five(good, 'a'), ...five(bad, 'a')];
    const recentlyBad = [...five(bad, 'b'), ...five(good, 'b')];
    const repo = {
      getResolvedForecasts: async () => [...recentlyGood, ...recentlyBad],
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map[mk('a')].rho).toBeGreaterThan(map[mk('b')].rho); // recent good > recent bad
  });

  it('computes per-agent independently in one pass', async () => {
    const mkRow = (id, outcome) =>
      Array.from({ length: 5 }, () => ({ agent_id: id, model: M, stance: 2, conviction: 1, outcome }));
    const repo = {
      getResolvedForecasts: async () => [...mkRow('a', 1), ...mkRow('b', 0)],
      upsertReliability: async () => {},
    };
    const map = await recomputeReliability(repo);
    expect(map[mk('a')].rho).toBeGreaterThan(1.1); // shrunk, but clearly above neutral
    expect(map[mk('b')].rho).toBeCloseTo(0.5); // anti-skill still saturates the floor
  });

  it('computes separate dials per (agent, model)', async () => {
    // 6 resolved forecasts for news on gpt-oss (all beat SPY) and 6 on qwen (all lagged)
    const mkForecast = (model, outcome) => ({
      agent_id: 'news', model, stance: 1, conviction: 0.8, outcome,
      forward_return: outcome ? 0.05 : -0.05, spy_return: 0, regime: 'calm',
    });
    const rows = [
      ...Array(6).fill(0).map(() => mkForecast('gpt-oss:20b', 1)),
      ...Array(6).fill(0).map(() => mkForecast('qwen2.5:7b-instruct', 0)),
    ];
    const upserts = [];
    const repo = {
      getResolvedForecasts: async () => rows,
      getFlooredStreaks: async () => ({}),
      upsertReliability: async (...a) => upserts.push(a),
      upsertRegimeReliability: async () => {},
      upsertLearnedPrior: async () => {},
      updateRosterFlag: async () => {},
    };
    const map = await recomputeReliability(repo, { warn() {} });
    const good = map[modelKey('news', 'gpt-oss:20b')];
    const bad = map[modelKey('news', 'qwen2.5:7b-instruct')];
    expect(good.rho).toBeGreaterThan(1.0); // skilled model
    expect(bad.rho).toBeLessThan(1.0); // unskilled model
    // upserts carry the model as the 2nd arg
    expect(upserts.every((a) => typeof a[1] === 'string')).toBe(true);
  });

  describe('roster watch (ADR 0028)', () => {
    const flooredForecasts = (id) =>
      Array.from({ length: 6 }, () => ({ agent_id: id, model: M, stance: 2, conviction: 1, outcome: 0 }));

    it('increments the floored streak and flags after the threshold', async () => {
      const flags = [];
      const map = await recomputeReliability(
        {
          getResolvedForecasts: async () => flooredForecasts('social'),
          upsertReliability: async () => {},
          getFlooredStreaks: async () => ({ social: { [M]: 5 } }), // one shy of the threshold
          updateRosterFlag: async (id, model, streak, flagged) => flags.push({ id, model, streak, flagged }),
        },
        { warn() {} },
      );
      expect(map[mk('social')].flooredStreak).toBe(6);
      expect(map[mk('social')].flagged).toBe(true);
      expect(flags).toEqual([{ id: 'social', model: M, streak: 6, flagged: true }]);
    });

    it('resets the streak and clears the flag when rho recovers', async () => {
      const flags = [];
      const healthy = Array.from({ length: 6 }, () => ({
        agent_id: 'social',
        model: M,
        stance: 2,
        conviction: 1,
        outcome: 1,
      }));
      await recomputeReliability(
        {
          getResolvedForecasts: async () => healthy,
          upsertReliability: async () => {},
          getFlooredStreaks: async () => ({ social: { [M]: 7 } }),
          updateRosterFlag: async (id, model, streak, flagged) => flags.push({ id, model, streak, flagged }),
        },
        { warn() {} },
      );
      expect(flags).toEqual([{ id: 'social', model: M, streak: 0, flagged: false }]);
    });
  });

  describe('regime buckets (ADR 0023)', () => {
    const row = (id, regime, outcome, stance = 2) => ({
      agent_id: id,
      model: M,
      stance,
      conviction: 1,
      outcome,
      regime,
    });

    it('persists per-regime dials for deep-enough buckets', async () => {
      const regimeWrites = [];
      const forecasts = [
        ...Array.from({ length: 6 }, () => row('tech', 'stressed', 1)),
        ...Array.from({ length: 6 }, () => row('tech', 'calm', 0)),
      ];
      await recomputeReliability({
        getResolvedForecasts: async () => forecasts,
        upsertReliability: async () => {},
        upsertRegimeReliability: async (id, regime, model, rho, n, calibration) =>
          regimeWrites.push({ id, regime, model, rho, n, calibration }),
      });
      const stressed = regimeWrites.find((w) => w.regime === 'stressed');
      const calm = regimeWrites.find((w) => w.regime === 'calm');
      // sharp in stressed tape, anti-skill in calm: the buckets disagree where
      // the unconditional average would blur them
      expect(stressed.rho).toBeGreaterThan(1);
      expect(calm.rho).toBeCloseTo(0.5);
    });

    it('skips thin buckets so the overlay falls back to unconditional dials', async () => {
      const regimeWrites = [];
      const forecasts = [
        ...Array.from({ length: 3 }, () => row('tech', 'stressed', 1)), // below MIN_RESOLVED
        ...Array.from({ length: 6 }, () => row('tech', null, 1)), // legacy rows, no regime
      ];
      await recomputeReliability({
        getResolvedForecasts: async () => forecasts,
        upsertReliability: async () => {},
        upsertRegimeReliability: async (...args) => regimeWrites.push(args),
      });
      expect(regimeWrites).toHaveLength(0);
    });
  });

  describe('information check (ADR 0021)', () => {
    const repoFor = (forecasts) => ({
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    });

    it('discounts a constant voter and leaves a moving voter at full info', async () => {
      const stuck = Array.from({ length: 8 }, () => ({
        agent_id: 'stuck',
        model: M,
        stance: 1,
        conviction: 0.7,
        outcome: 1,
      }));
      const moving = [1, -1, 2, 0, 1, -2, 0, 1].map((stance) => ({
        agent_id: 'moving',
        model: M,
        stance,
        conviction: 0.7,
        outcome: 1,
      }));
      const map = await recomputeReliability(repoFor([...stuck, ...moving]));
      expect(map[mk('stuck')].info).toBe(0.25);
      expect(map[mk('moving')].info).toBe(1);
    });

    it('persists the info factor alongside rho and calibration', async () => {
      const writes = [];
      const forecasts = Array.from({ length: 6 }, () => ({
        agent_id: 'stuck',
        model: M,
        stance: 2,
        conviction: 1,
        outcome: 1,
      }));
      await recomputeReliability({
        getResolvedForecasts: async () => forecasts,
        upsertReliability: async (id, model, rho, n, calibration, info) =>
          writes.push({ id, model, calibration, info }),
      });
      expect(writes[0].info).toBe(0.25);
    });

    it('stays neutral below MIN_RESOLVED', async () => {
      const forecasts = Array.from({ length: 3 }, () => ({
        agent_id: 'young',
        model: M,
        stance: 1,
        conviction: 0.5,
        outcome: 1,
      }));
      const map = await recomputeReliability(repoFor(forecasts));
      expect(map[mk('young')].info).toBe(1.0);
    });
  });

  describe('graded outcomes (ADR 0018)', () => {
    const repoFor = (forecasts) => ({
      getResolvedForecasts: async () => forecasts,
      upsertReliability: async () => {},
    });

    it('rewards a confident call that won big more than one that scraped by', async () => {
      const mkRow = (id, alpha) =>
        Array.from({ length: 6 }, () => ({
          agent_id: id,
          model: M,
          stance: 2,
          conviction: 1,
          outcome: 1,
          forward_return: alpha,
          spy_return: 0,
        }));
      const map = await recomputeReliability(repoFor([...mkRow('big', 0.08), ...mkRow('thin', 0.001)]));
      expect(map[mk('big')].rho).toBeGreaterThan(map[mk('thin')].rho);
    });

    it('keeps a HOLD-everything forecaster neutral even when alphas are tiny', async () => {
      // p = 0.5 forecasts against outcomes hugging 0.5: under a fixed 0.25 baseline
      // this would inflate rho; the skill-score baseline keeps it at 1.0.
      const forecasts = Array.from({ length: 8 }, () => ({
        agent_id: 'flat',
        model: M,
        stance: 0,
        conviction: 0.9,
        outcome: 1,
        forward_return: 0.0005,
        spy_return: 0,
      }));
      const map = await recomputeReliability(repoFor(forecasts));
      expect(map[mk('flat')].rho).toBeCloseTo(1.0);
    });

    it('falls back to the binary outcome for legacy rows without returns', async () => {
      const forecasts = Array.from({ length: 6 }, () => ({
        agent_id: 'legacy',
        model: M,
        stance: 2,
        conviction: 1,
        outcome: 1,
        forward_return: null,
        spy_return: null,
      }));
      const map = await recomputeReliability(repoFor(forecasts));
      // scored exactly like the binary path (shrinkage applies either way)
      expect(map[mk('legacy')].rho).toBeGreaterThan(1.15);
      expect(map[mk('legacy')].rho).toBeLessThan(1.5);
    });

    it('punishes large misses harder than near-misses on the same hit record', async () => {
      // Both agents: 3 wins at +5% alpha; the misses differ only in magnitude.
      const row = (id, alpha, outcome) => ({
        agent_id: id,
        model: M,
        stance: 2,
        conviction: 0.5,
        outcome,
        forward_return: alpha,
        spy_return: 0,
      });
      const record = (id, missAlpha) => [
        ...Array.from({ length: 3 }, () => row(id, 0.05, 1)),
        ...Array.from({ length: 3 }, () => row(id, missAlpha, 0)),
      ];
      const map = await recomputeReliability(
        repoFor([...record('disaster', -0.1), ...record('near', -0.002)]),
      );
      expect(map[mk('disaster')].rho).toBeLessThan(map[mk('near')].rho);
      expect(map[mk('near')].rho).toBeGreaterThan(1); // wins big, misses small -> net positive skill
    });
  });
});
