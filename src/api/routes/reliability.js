import { Router } from 'express';
import { summarizeAgents } from '../../reliability/performance.js';
import { WINDOW } from '../../consensus/reliability.js';
import { modelKey } from '../../llm/provider.js';

// Headroom multiplier matching getResolvedForecasts: enough rows to cover every
// agent's window even in a large panel.
const BOARD_HEADROOM = 8;

// Reliability leaderboard (per-(agent, model) ρ_i ordered by rho desc), enriched
// with win/loss/hold record, hit rate, and alpha magnitude per the v2 data contract.
export function reliabilityRoutes(repo) {
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

  return router;
}
