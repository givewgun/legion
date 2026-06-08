import { STANCE } from '../consensus/stance.js';

// Persistence over the legion schema. Each method maps to one INSERT/UPDATE.
export function createRepo(db) {
  return {
    async createCycle(symbol) {
      // Seed the ticker first (cycles.symbol has an FK to legion.tickers) so the
      // live `kick <TICKER>` path works on a freshly migrated database. Done in a
      // single statement via a CTE so it stays one round-trip and one query call.
      const row = await db.queryOne(
        `WITH seeded AS (
           INSERT INTO legion.tickers (symbol) VALUES ($1)
           ON CONFLICT (symbol) DO NOTHING
         )
         INSERT INTO legion.cycles (symbol) VALUES ($1) RETURNING id`,
        [symbol],
      );
      return row.id;
    },

    async addRound(cycleId, roundNo, { S, V, kappa, converged }) {
      const row = await db.queryOne(
        `INSERT INTO legion.rounds (cycle_id, round_no, s_score, dispersion, quorum, converged)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [cycleId, roundNo, S, V, kappa, converged],
      );
      return row.id;
    },

    async addVote(roundId, vote) {
      const row = await db.queryOne(
        `INSERT INTO legion.votes (round_id, agent_id, stance, conviction, weight, rationale)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [roundId, vote.agentId, vote.stance, vote.conviction, vote.weight, vote.rationale],
      );
      return row.id;
    },

    async addSignal(cycleId, signal) {
      const row = await db.queryOne(
        `INSERT INTO legion.signals
           (cycle_id, symbol, band, conviction, plan, entry_price, horizon_days, resolve_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          cycleId,
          signal.symbol,
          signal.band,
          signal.conviction,
          JSON.stringify(signal.plan),
          signal.entryPrice ?? null,
          signal.horizonDays ?? 5,
          signal.resolveAfter ?? null,
        ],
      );
      return row.id;
    },

    async addSignalVotes(signalId, votes) {
      if (!votes.length) return;
      const tuples = [];
      const params = [];
      votes.forEach((v, i) => {
        const b = i * 5;
        tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
        params.push(signalId, v.agentId, v.stance, v.conviction, v.weight);
      });
      await db.query(
        `INSERT INTO legion.signal_votes (signal_id, agent_id, stance, conviction, weight)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    },

    async getAllReliability() {
      const rows = await db.query(`SELECT agent_id, rho FROM legion.agent_reliability`);
      return Object.fromEntries(rows.map((r) => [r.agent_id, r.rho]));
    },

    async upsertReliability(agentId, rho, sampleSize) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, rho, sample_size, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (agent_id) DO UPDATE
           SET rho = EXCLUDED.rho, sample_size = EXCLUDED.sample_size, updated_at = now()`,
        [agentId, rho, sampleSize],
      );
    },

    async getReliabilityLeaderboard() {
      const rows = await db.query(
        `SELECT agent_id, rho, sample_size FROM legion.agent_reliability ORDER BY rho DESC`,
      );
      return rows.map((r) => ({ agentId: r.agent_id, rho: r.rho, sampleSize: r.sample_size }));
    },

    async listUnresolvedSignals(now) {
      return db.query(
        `SELECT id, symbol, created_at, entry_price, resolve_after
           FROM legion.signals
          WHERE resolved = false AND resolve_after IS NOT NULL AND resolve_after <= $1
          ORDER BY resolve_after ASC`,
        [now],
      );
    },

    async resolveSignal(id, { forwardReturn, spyReturn, qqqReturn, outcome, correct }) {
      await db.query(
        `UPDATE legion.signals
            SET forward_return = $1, spy_return = $2, qqq_return = $3,
                outcome = $4, correct = $5, resolved = true
          WHERE id = $6`,
        [forwardReturn, spyReturn, qqqReturn, outcome, correct, id],
      );
    },

    async getSignalStance(id) {
      const row = await db.queryOne(`SELECT band FROM legion.signals WHERE id = $1`, [id]);
      return STANCE[row?.band] ?? 0;
    },

    async getResolvedForecasts(limit) {
      return db.query(
        `SELECT sv.agent_id, sv.stance, sv.conviction, s.outcome
           FROM legion.signal_votes sv
           JOIN legion.signals s ON s.id = sv.signal_id
          WHERE s.resolved = true AND s.outcome IS NOT NULL
          ORDER BY s.id DESC
          LIMIT $1`,
        [limit],
      );
    },

    async recordBacktestResult({ symbol, horizon, trades, hits, hitRate, pnl, spyPnl, qqqPnl }) {
      await db.query(
        `INSERT INTO legion.backtest_results
           (symbol, horizon, trades, hits, hit_rate, pnl, spy_pnl, qqq_pnl)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [symbol, horizon, trades, hits, hitRate, pnl, spyPnl, qqqPnl],
      );
    },

    async listBacktestResults(symbol, limit) {
      if (symbol) {
        return db.query(
          `SELECT * FROM legion.backtest_results WHERE symbol = $1 ORDER BY created_at DESC LIMIT $2`,
          [symbol.toUpperCase(), limit],
        );
      }
      return db.query(`SELECT * FROM legion.backtest_results ORDER BY created_at DESC LIMIT $1`, [
        limit,
      ]);
    },

    async finishCycle(cycleId, status) {
      await db.query(`UPDATE legion.cycles SET status = $1, ended_at = now() WHERE id = $2`, [
        status,
        cycleId,
      ]);
    },

    async listEnabledTickers() {
      // db.query returns the rows array directly (see src/db/client.js).
      const rows = await db.query(
        `SELECT symbol FROM legion.tickers WHERE enabled = true ORDER BY symbol`,
      );
      return rows.map((r) => r.symbol);
    },

    async listTickers() {
      const rows = await db.query(`SELECT symbol, enabled FROM legion.tickers ORDER BY symbol`);
      return rows;
    },

    async upsertTicker(symbol) {
      return db.queryOne(
        `INSERT INTO legion.tickers (symbol, enabled) VALUES ($1, true)
         ON CONFLICT (symbol) DO UPDATE SET enabled = true
         RETURNING symbol, enabled`,
        [symbol.toUpperCase()],
      );
    },

    async setTickerEnabled(symbol, enabled) {
      return db.queryOne(
        `UPDATE legion.tickers SET enabled = $1 WHERE symbol = $2
         RETURNING symbol, enabled`,
        [enabled, symbol.toUpperCase()],
      );
    },

    async listCycles(symbol, limit = 20) {
      const rows = await db.query(
        `SELECT id, symbol, status, started_at, ended_at
         FROM legion.cycles WHERE symbol = $1
         ORDER BY id DESC LIMIT $2`,
        [symbol.toUpperCase(), limit],
      );
      return rows;
    },

    // One row per symbol that has at least one cycle, carrying its newest
    // cycle's id/status/start time and the total cycle count. Newest first,
    // so the Debate tab can show "what data do we have" without a per-symbol
    // round trip.
    async listTickersWithCycles() {
      const rows = await db.query(
        `SELECT symbol, latest_cycle_id, latest_status, latest_started_at, cycle_count
         FROM (
           SELECT DISTINCT ON (symbol)
                  symbol,
                  id AS latest_cycle_id,
                  status AS latest_status,
                  started_at AS latest_started_at,
                  COUNT(*) OVER (PARTITION BY symbol)::int AS cycle_count
           FROM legion.cycles
           ORDER BY symbol, id DESC
         ) latest
         ORDER BY latest_started_at DESC NULLS LAST`,
      );
      return rows;
    },

    async getCycle(id) {
      return db.queryOne(
        `SELECT id, symbol, status, started_at, ended_at FROM legion.cycles WHERE id = $1`,
        [id],
      );
    },

    async getRounds(cycleId) {
      const rows = await db.query(
        `SELECT id, round_no, s_score, dispersion, quorum, converged
         FROM legion.rounds WHERE cycle_id = $1 ORDER BY round_no`,
        [cycleId],
      );
      return rows;
    },

    async getVotes(roundId) {
      const rows = await db.query(
        `SELECT agent_id, stance, conviction, weight, rationale
         FROM legion.votes WHERE round_id = $1 ORDER BY agent_id`,
        [roundId],
      );
      return rows;
    },

    async listSignals(symbol, limit = 50) {
      if (symbol) {
        const rows = await db.query(
          `SELECT id, symbol, band, conviction, plan, created_at
           FROM legion.signals WHERE symbol = $1 ORDER BY id DESC LIMIT $2`,
          [symbol.toUpperCase(), limit],
        );
        return rows;
      }
      const rows = await db.query(
        `SELECT id, symbol, band, conviction, plan, created_at
         FROM legion.signals ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },

    async listSignalsSince(since) {
      const rows = await db.query(
        `SELECT symbol, band, conviction, created_at
           FROM legion.signals
          WHERE created_at >= $1
          ORDER BY created_at DESC`,
        [since],
      );
      return rows.map((r) => ({
        symbol: r.symbol,
        stance: STANCE[r.band] ?? 0,
        conviction: r.conviction,
        created_at: r.created_at,
      }));
    },

    async getAllAgentConfig() {
      const rows = await db.query(
        `SELECT agent_id, provider, model, enabled FROM legion.agent_config`,
      );
      return Object.fromEntries(
        rows.map((r) => [r.agent_id, { provider: r.provider, model: r.model, enabled: r.enabled }]),
      );
    },

    async getAgentConfig(agentId) {
      const row = await db.queryOne(
        `SELECT provider, model, enabled FROM legion.agent_config WHERE agent_id = $1`,
        [agentId],
      );
      if (!row) return null;
      return { provider: row.provider, model: row.model, enabled: row.enabled };
    },

    async upsertAgentConfig(agentId, { provider, model, enabled }) {
      await db.query(
        `INSERT INTO legion.agent_config (agent_id, provider, model, enabled, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (agent_id) DO UPDATE
           SET provider = EXCLUDED.provider, model = EXCLUDED.model,
               enabled = EXCLUDED.enabled, updated_at = now()`,
        [agentId, provider, model, enabled],
      );
    },
  };
}
