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

    async addRound(cycleId, roundNo, { S, V, kappa, A = null, converged }) {
      const row = await db.queryOne(
        `INSERT INTO legion.rounds (cycle_id, round_no, s_score, dispersion, quorum, agreement, converged)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [cycleId, roundNo, S, V, kappa, A, converged],
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
           (cycle_id, symbol, band, conviction, plan, entry_price, spy_entry_price,
            qqq_entry_price, horizon_days, resolve_after, regime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          cycleId,
          signal.symbol,
          signal.band,
          signal.conviction,
          JSON.stringify(signal.plan),
          signal.entryPrice ?? null,
          signal.spyEntryPrice ?? null,
          signal.qqqEntryPrice ?? null,
          signal.horizonDays ?? 5,
          signal.resolveAfter ?? null,
          signal.regime ?? null,
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

    async getAgentCalibration() {
      const rows = await db.query(`SELECT agent_id, calibration FROM legion.agent_reliability`);
      return Object.fromEntries(rows.map((r) => [r.agent_id, r.calibration]));
    },

    // Information factor (ADR 0021): conviction discount for near-constant voters.
    async getAgentInfoFactors() {
      const rows = await db.query(`SELECT agent_id, info_factor FROM legion.agent_reliability`);
      return Object.fromEntries(rows.map((r) => [r.agent_id, r.info_factor]));
    },

    async upsertReliability(agentId, rho, sampleSize, calibration = 1.0, infoFactor = 1.0) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, rho, sample_size, calibration, info_factor, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (agent_id) DO UPDATE
           SET rho = EXCLUDED.rho, sample_size = EXCLUDED.sample_size,
               calibration = EXCLUDED.calibration, info_factor = EXCLUDED.info_factor,
               updated_at = now()`,
        [agentId, rho, sampleSize, calibration, infoFactor],
      );
    },

    // Stances for the most recent `signalLimit` signals, for co-movement (ADR 0015).
    async getVoteHistory(signalLimit) {
      return db.query(
        `SELECT signal_id, agent_id, stance
           FROM legion.signal_votes
          WHERE signal_id IN (SELECT id FROM legion.signals ORDER BY id DESC LIMIT $1)
          ORDER BY signal_id`,
        [signalLimit],
      );
    },

    // Replace the whole correlation table with the freshly computed pairs. A full
    // replace (not upsert) so pairs that age out of the recent window — fell below
    // MIN_CORR_PAIRS, went zero-variance, or lost an agent — stop discounting the
    // quorum instead of lingering as stale rows (ADR 0015).
    async replaceCorrelations(pairs) {
      await db.query(`DELETE FROM legion.agent_correlation`);
      if (!pairs.length) return;
      const tuples = [];
      const params = [];
      pairs.forEach((p, i) => {
        const b = i * 4;
        tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, now())`);
        params.push(p.a, p.b, p.corr, p.n);
      });
      await db.query(
        `INSERT INTO legion.agent_correlation (agent_a, agent_b, corr, sample_size, updated_at)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    },

    // Symmetric nested lookup { a: { b: corr }, b: { a: corr } } for the emitter.
    async getAgentCorrelations() {
      const rows = await db.query(`SELECT agent_a, agent_b, corr FROM legion.agent_correlation`);
      const map = {};
      for (const r of rows) {
        (map[r.agent_a] ??= {})[r.agent_b] = r.corr;
        (map[r.agent_b] ??= {})[r.agent_a] = r.corr;
      }
      return map;
    },

    // Long-window learned prior (ADR 0027) — measured, not yet applied.
    async upsertLearnedPrior(agentId, learnedPrior) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, learned_prior, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (agent_id) DO UPDATE
           SET learned_prior = EXCLUDED.learned_prior, updated_at = now()`,
        [agentId, learnedPrior],
      );
    },

    // Roster watch (ADR 0028): how long each agent has sat at the rho floor.
    async getFlooredStreaks() {
      const rows = await db.query(`SELECT agent_id, floored_streak FROM legion.agent_reliability`);
      return Object.fromEntries(rows.map((r) => [r.agent_id, r.floored_streak]));
    },

    async updateRosterFlag(agentId, flooredStreak, flagged) {
      await db.query(
        `UPDATE legion.agent_reliability
            SET floored_streak = $2, flagged = $3, updated_at = now()
          WHERE agent_id = $1`,
        [agentId, flooredStreak, flagged],
      );
    },

    async getReliabilityLeaderboard() {
      const rows = await db.query(
        `SELECT agent_id, rho, sample_size, calibration, info_factor, learned_prior,
                floored_streak, flagged
           FROM legion.agent_reliability ORDER BY rho DESC`,
      );
      return rows.map((r) => ({
        agentId: r.agent_id,
        rho: r.rho,
        sampleSize: r.sample_size,
        calibration: r.calibration,
        infoFactor: r.info_factor,
        learnedPrior: r.learned_prior,
        flooredStreak: r.floored_streak,
        flagged: r.flagged,
      }));
    },

    async listUnresolvedSignals(now) {
      return db.query(
        `SELECT id, symbol, created_at, entry_price, spy_entry_price, qqq_entry_price, resolve_after
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
      // forward_return/spy_return feed the magnitude-aware graded outcome
      // (ADR 0018); regime feeds the per-regime buckets (ADR 0023). Rows
      // resolved before those columns existed fall back to the binary outcome
      // and the unconditional dials.
      return db.query(
        `SELECT sv.agent_id, sv.stance, sv.conviction, s.outcome,
                s.forward_return, s.spy_return, s.regime
           FROM legion.signal_votes sv
           JOIN legion.signals s ON s.id = sv.signal_id
          WHERE s.resolved = true AND s.outcome IS NOT NULL
          ORDER BY s.id DESC
          LIMIT $1`,
        [limit],
      );
    },

    // Per-(agent, regime) dials (ADR 0023). Rows exist only for buckets deep
    // enough to learn from, so these maps overlay the unconditional ones.
    async getRegimeReliability(regime) {
      const rows = await db.query(
        `SELECT agent_id, rho FROM legion.agent_regime_reliability WHERE regime = $1`,
        [regime],
      );
      return Object.fromEntries(rows.map((r) => [r.agent_id, r.rho]));
    },

    async getRegimeCalibration(regime) {
      const rows = await db.query(
        `SELECT agent_id, calibration FROM legion.agent_regime_reliability WHERE regime = $1`,
        [regime],
      );
      return Object.fromEntries(rows.map((r) => [r.agent_id, r.calibration]));
    },

    async upsertRegimeReliability(agentId, regime, rho, sampleSize, calibration = 1.0) {
      await db.query(
        `INSERT INTO legion.agent_regime_reliability (agent_id, regime, rho, calibration, sample_size, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (agent_id, regime) DO UPDATE
           SET rho = EXCLUDED.rho, calibration = EXCLUDED.calibration,
               sample_size = EXCLUDED.sample_size, updated_at = now()`,
        [agentId, regime, rho, calibration, sampleSize],
      );
    },

    // One agent's graded history for the memory block (ADR 0025): overall
    // directional hit count over the recent window, plus its latest resolved
    // calls on this symbol (most recent first).
    async getAgentTrackRecord(agentId, symbol, { overallLimit = 20, recentLimit = 3 } = {}) {
      const [overallRow, recent] = await Promise.all([
        db.queryOne(
          `SELECT COUNT(*)::int AS total,
                  COALESCE(SUM(CASE WHEN sv.stance > 0 THEN s.outcome
                                    ELSE 1 - s.outcome END), 0)::int AS hits
             FROM (SELECT sv.stance, sv.signal_id
                     FROM legion.signal_votes sv
                     JOIN legion.signals s ON s.id = sv.signal_id
                    WHERE sv.agent_id = $1 AND sv.stance <> 0
                      AND s.resolved = true AND s.outcome IS NOT NULL
                    ORDER BY s.id DESC
                    LIMIT $2) sv
             JOIN legion.signals s ON s.id = sv.signal_id`,
          [agentId, overallLimit],
        ),
        db.query(
          `SELECT s.symbol, sv.stance, sv.conviction, s.outcome,
                  s.forward_return, s.spy_return
             FROM legion.signal_votes sv
             JOIN legion.signals s ON s.id = sv.signal_id
            WHERE sv.agent_id = $1 AND s.symbol = $2
              AND s.resolved = true AND s.outcome IS NOT NULL
            ORDER BY s.id DESC
            LIMIT $3`,
          [agentId, symbol, recentLimit],
        ),
      ]);
      return { overall: { hits: overallRow?.hits ?? 0, total: overallRow?.total ?? 0 }, recent };
    },

    // ── Meta-reflection lessons (ADR 0026) ──────────────────────────────────

    // The agent's recent resolved calls graded *wrong* (directional misses),
    // newest first — the raw material the reflection pass distills.
    async getAgentMisses(agentId, limit = 10) {
      return db.query(
        `SELECT s.symbol, sv.stance, sv.conviction, s.outcome,
                s.forward_return, s.spy_return, s.regime
           FROM legion.signal_votes sv
           JOIN legion.signals s ON s.id = sv.signal_id
          WHERE sv.agent_id = $1 AND sv.stance <> 0
            AND s.resolved = true AND s.outcome IS NOT NULL
            AND ((sv.stance > 0 AND s.outcome = 0) OR (sv.stance < 0 AND s.outcome = 1))
          ORDER BY s.id DESC
          LIMIT $2`,
        [agentId, limit],
      );
    },

    async upsertAgentLesson(agentId, lesson, sampleSize) {
      await db.query(
        `INSERT INTO legion.agent_lessons (agent_id, lesson, sample_size, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (agent_id) DO UPDATE
           SET lesson = EXCLUDED.lesson, sample_size = EXCLUDED.sample_size, updated_at = now()`,
        [agentId, lesson, sampleSize],
      );
    },

    async getAgentLesson(agentId) {
      const row = await db.queryOne(`SELECT lesson FROM legion.agent_lessons WHERE agent_id = $1`, [
        agentId,
      ]);
      return row?.lesson ?? null;
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

    // ── Crash-recovery pending state (ADR 0024) ─────────────────────────────
    // Every vote/constraint the emitter buffers in memory is mirrored here so a
    // restart can rebuild in-flight rounds instead of silently dropping them.

    async savePendingVote(cycleId, round, symbol, vote) {
      await db.query(
        `INSERT INTO legion.pending_votes (cycle_id, round, symbol, agent_id, vote)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cycle_id, round, agent_id)
           DO UPDATE SET vote = EXCLUDED.vote, created_at = now()`,
        [cycleId, round, symbol, vote.agentId, JSON.stringify(vote)],
      );
    },

    async savePendingConstraint(cycleId, round, symbol, constraint) {
      await db.query(
        `INSERT INTO legion.pending_constraints (cycle_id, round, symbol, payload)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cycle_id, round)
           DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
        [cycleId, round, symbol, JSON.stringify(constraint)],
      );
    },

    async loadPendingVotes(since) {
      return db.query(
        `SELECT cycle_id, round, symbol, vote
           FROM legion.pending_votes
          WHERE created_at >= $1
          ORDER BY cycle_id, round`,
        [since],
      );
    },

    async loadPendingConstraints(since) {
      return db.query(
        `SELECT cycle_id, round, symbol, payload
           FROM legion.pending_constraints
          WHERE created_at >= $1
          ORDER BY cycle_id, round`,
        [since],
      );
    },

    async deletePendingCycle(cycleId) {
      await db.query(`DELETE FROM legion.pending_votes WHERE cycle_id = $1`, [cycleId]);
      await db.query(`DELETE FROM legion.pending_constraints WHERE cycle_id = $1`, [cycleId]);
    },

    async deletePendingBefore(cutoff) {
      await db.query(`DELETE FROM legion.pending_votes WHERE created_at < $1`, [cutoff]);
      await db.query(`DELETE FROM legion.pending_constraints WHERE created_at < $1`, [cutoff]);
    },

    // Whether a round was already aggregated — recovery must not re-run it.
    async roundExists(cycleId, roundNo) {
      const row = await db.queryOne(
        `SELECT 1 AS one FROM legion.rounds WHERE cycle_id = $1 AND round_no = $2`,
        [cycleId, roundNo],
      );
      return row != null;
    },

    // Whether the cycle already emitted its signal — recovery completing a
    // crashed final round must never emit twice.
    async cycleHasSignal(cycleId) {
      const row = await db.queryOne(`SELECT 1 AS one FROM legion.signals WHERE cycle_id = $1`, [
        cycleId,
      ]);
      return row != null;
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
