// Persistence over the legion schema. Each method maps to one INSERT/UPDATE.
export function createRepo(db) {
  return {
    async createCycle(symbol) {
      const row = await db.queryOne(`INSERT INTO legion.cycles (symbol) VALUES ($1) RETURNING id`, [
        symbol,
      ]);
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
