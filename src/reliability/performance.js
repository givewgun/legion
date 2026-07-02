import { WINDOW } from '../consensus/reliability.js';
import { modelKey } from '../llm/provider.js';

// Number of recent calls to include in the `recent` array per agent.
const RECENT_LIMIT = 10;

/**
 * Computes the directional win/loss for one resolved call.
 * Returns true (win), false (loss), or null (hold — stance === 0).
 *
 * @param {number} stance
 * @param {number} outcome
 * @returns {boolean|null}
 */
function isWin(stance, outcome) {
  if (stance === 0) return null;
  if (stance > 0) return outcome === 1;
  return outcome === 0;
}

/**
 * Alpha for one call: forward_return - spy_return.
 * Returns null when either leg is missing (legacy rows).
 *
 * @param {number|null} forwardReturn
 * @param {number|null} spyReturn
 * @returns {number|null}
 */
function callAlpha(forwardReturn, spyReturn) {
  if (forwardReturn == null || spyReturn == null) return null;
  return forwardReturn - spyReturn;
}

/**
 * Pure aggregation of signal_votes ⋈ signals rows into per-(agent, model) performance
 * summaries — the same segmentation the reliability dials use, so a board row's
 * Record/Hit%/alpha describe the SAME bucket as its ρ (one agent served by two models
 * has two independent track records, not one blended one).
 *
 * Rows must be ordered newest-first (matching `getResolvedForecasts` / `getAgentBoardRows`
 * ordering). Each bucket is capped at `window` rows, mirroring the bucketing in
 * `src/reliability/update.js`, so counts reconcile with the ρ sample.
 *
 * @param {Array<{agent_id: string, model?: string|null, stance: number, conviction: number,
 *   outcome: number, forward_return: number|null, spy_return: number|null,
 *   symbol?: string}>} rows
 * @param {{ window?: number }} options
 * @returns {Map<string, {wins: number, losses: number, holds: number,
 *   hitRate: number|null, avgAlpha: number|null, bestAlpha: number|null,
 *   worstAlpha: number|null, sample: number,
 *   recent: Array<{symbol: string|undefined, stance: number, conviction: number,
 *     win: boolean|null, alpha: number|null}>}>} keyed by `modelKey(agent_id, model)`
 */
export function summarizeAgents(rows, { window = WINDOW } = {}) {
  // Step 1: bucket per (agent, model), newest-first, capped at window (mirrors
  // bucketByAgentModel in update.js).
  const buckets = new Map();
  for (const r of rows) {
    const key = modelKey(r.agent_id, r.model);
    if (!buckets.has(key)) buckets.set(key, []);
    const bucket = buckets.get(key);
    if (bucket.length < window) bucket.push(r);
  }

  // Step 2: aggregate each bucket.
  const result = new Map();
  for (const [key, bucket] of buckets) {
    let wins = 0;
    let losses = 0;
    let holds = 0;
    const alphas = [];

    for (const r of bucket) {
      const win = isWin(r.stance, r.outcome);
      if (win === null) {
        holds += 1;
      } else if (win) {
        wins += 1;
      } else {
        losses += 1;
      }

      // Alpha is computed for directional calls with both returns present.
      if (r.stance !== 0) {
        const alpha = callAlpha(r.forward_return, r.spy_return);
        if (alpha !== null) alphas.push(alpha);
      }
    }

    const directional = wins + losses;
    const hitRate = directional > 0 ? wins / directional : null;

    let avgAlpha = null;
    let bestAlpha = null;
    let worstAlpha = null;
    if (alphas.length > 0) {
      avgAlpha = alphas.reduce((sum, a) => sum + a, 0) / alphas.length;
      bestAlpha = Math.max(...alphas);
      worstAlpha = Math.min(...alphas);
    }

    // recent: newest-first slice, capped at RECENT_LIMIT.
    const recent = bucket.slice(0, RECENT_LIMIT).map((r) => ({
      symbol: r.symbol,
      stance: r.stance,
      conviction: r.conviction,
      win: isWin(r.stance, r.outcome),
      alpha: callAlpha(r.forward_return, r.spy_return),
    }));

    result.set(key, {
      wins,
      losses,
      holds,
      hitRate,
      avgAlpha,
      bestAlpha,
      worstAlpha,
      sample: bucket.length,
      recent,
    });
  }

  return result;
}
