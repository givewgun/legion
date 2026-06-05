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
        `INSERT INTO legion.signals (cycle_id, symbol, band, conviction, plan)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [cycleId, signal.symbol, signal.band, signal.conviction, JSON.stringify(signal.plan)],
      );
      return row.id;
    },

    async finishCycle(cycleId, status) {
      await db.query(`UPDATE legion.cycles SET status = $1, ended_at = now() WHERE id = $2`, [
        status,
        cycleId,
      ]);
    },
  };
}
