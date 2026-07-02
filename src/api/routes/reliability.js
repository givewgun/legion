import { Router } from 'express';
import { summarizeAgents } from '../../reliability/performance.js';
import { WINDOW } from '../../consensus/reliability.js';
import { modelKey } from '../../llm/provider.js';
import { runReliabilityOnce } from '../../reliability/run-once.js';

// Headroom multiplier matching getResolvedForecasts: enough rows to cover every
// agent's window even in a large panel.
const BOARD_HEADROOM = 8;

// Reliability leaderboard (per-(agent, model) ρ_i ordered by rho desc), enriched
// with win/loss/hold record, hit rate, and alpha magnitude per the v2 data contract.
// POST /relearn runs the same resolve+recompute pass as the reliability cron, on
// demand from the dashboard (no reflection — never an LLM call from the API box).
// `gunvest` feeds the signal resolver; without it the endpoint is 503 (data-only
// mode). `runOnce` is injectable for tests.
export function reliabilityRoutes(repo, { gunvest = null, runOnce = runReliabilityOnce } = {}) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const [leaderboard, boardRows] = await Promise.all([
        repo.getReliabilityLeaderboard(),
        repo.getAgentBoardRows(WINDOW * BOARD_HEADROOM),
      ]);

      const perfMap = summarizeAgents(boardRows, { window: WINDOW });

      // The leaderboard drives the output: every agent with resolved board rows
      // also has a dial (recomputeReliability upserts one per agent in the same
      // pass), so iterating dials misses nothing in practice. An agent with
      // board rows but no dial would be dropped — acceptable per the contract,
      // which only guarantees the dial-without-rows direction.
      // Dials and board rows are both segmented per (agent, model) — one agent
      // served by two models is two leaderboard rows with independent records.
      const result = leaderboard.map((dial) => {
        const perf = perfMap.get(modelKey(dial.agentId, dial.model));
        return {
          // Existing dial fields (backward compatible)
          agentId: dial.agentId,
          model: dial.model ?? null,
          rho: dial.rho,
          sampleSize: dial.sampleSize,
          calibration: dial.calibration,
          infoFactor: dial.infoFactor,
          learnedPrior: dial.learnedPrior,
          flagged: dial.flagged,
          flooredStreak: dial.flooredStreak,
          // New performance fields — zeroed/null when no board rows exist for agent
          wins: perf?.wins ?? 0,
          losses: perf?.losses ?? 0,
          holds: perf?.holds ?? 0,
          hitRate: perf?.hitRate ?? null,
          avgAlpha: perf?.avgAlpha ?? null,
          bestAlpha: perf?.bestAlpha ?? null,
          worstAlpha: perf?.worstAlpha ?? null,
          recent: perf?.recent ?? [],
        };
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Operator reset: forget every learned dial AND the graded forecast snapshots
  // they derive from, so the panel restarts at neutral 1.0 and a later relearn
  // cannot resurrect the old record. Destructive by design — the dashboard
  // confirms before calling. Signals / backtest history stay intact.
  router.post('/reset', async (req, res, next) => {
    try {
      res.json({ cleared: await repo.resetReliability() });
    } catch (err) {
      next(err);
    }
  });

  // Relearn now: resolve due signals, recompute the dials and correlations.
  // Idempotent DB work (the same pass the cron runs), so a manual re-kick is safe.
  router.post('/relearn', async (req, res, next) => {
    if (!gunvest) {
      return res.status(503).json({ error: 'relearn unavailable: GunVest client not configured' });
    }
    try {
      const { resolved, reliability, correlations } = await runOnce({ repo, gunvest });
      res.json({ resolved, correlations, agents: Object.keys(reliability).length });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
