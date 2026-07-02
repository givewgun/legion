import { STANCE } from '../consensus/stance.js';

// Folds flat (agent_id, model, value) rows into { [agentId]: { [model]: value } }.
// The emitter composes the (agent, model) lookup; the repo stays SQL-shaped.
function nestByAgentModel(rows, valueKey) {
  const out = {};
  for (const r of rows) {
    (out[r.agent_id] ??= {})[r.model] = r[valueKey];
  }
  return out;
}

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

    // ON CONFLICT DO NOTHING makes the round insert idempotent against the
    // UNIQUE (cycle_id, round_no) constraint: a duplicate returns no row, so the
    // caller (emitter.process) gets null and skips re-emitting rather than
    // crashing on a 23505 (a crash-recovery vs. live-vote race — ADR 0024).
    async addRound(cycleId, roundNo, { S, V, kappa, A = null, drift = null, converged }) {
      const row = await db.queryOne(
        `INSERT INTO legion.rounds (cycle_id, round_no, s_score, dispersion, quorum, agreement, drift, converged)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (cycle_id, round_no) DO NOTHING
         RETURNING id`,
        [cycleId, roundNo, S, V, kappa, A, drift, converged],
      );
      return row?.id ?? null;
    },

    async addVote(roundId, vote) {
      const row = await db.queryOne(
        `INSERT INTO legion.votes (round_id, agent_id, stance, conviction, weight, rationale, thought, model, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [roundId, vote.agentId, vote.stance, vote.conviction, vote.weight, vote.rationale, vote.thought ?? null, vote.model ?? null, vote.source ?? null],
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
        const b = i * 6;
        tuples.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
        params.push(
          signalId, v.agentId, v.stance, v.conviction, v.weight,
          v.model ?? 'qwen2.5:7b-instruct',
        );
      });
      await db.query(
        `INSERT INTO legion.signal_votes (signal_id, agent_id, stance, conviction, weight, model)
         VALUES ${tuples.join(', ')}`,
        params,
      );
    },

    async getAllReliability() {
      const rows = await db.query(`SELECT agent_id, model, rho FROM legion.agent_reliability`);
      return nestByAgentModel(rows, 'rho');
    },

    async getAgentCalibration() {
      const rows = await db.query(
        `SELECT agent_id, model, calibration FROM legion.agent_reliability`,
      );
      return nestByAgentModel(rows, 'calibration');
    },

    // Information factor (ADR 0021): conviction discount for near-constant voters.
    async getAgentInfoFactors() {
      const rows = await db.query(
        `SELECT agent_id, model, info_factor FROM legion.agent_reliability`,
      );
      return nestByAgentModel(rows, 'info_factor');
    },

    async upsertReliability(agentId, model, rho, sampleSize, calibration = 1.0, infoFactor = 1.0) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, model, rho, sample_size, calibration, info_factor, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (agent_id, model) DO UPDATE
           SET rho = EXCLUDED.rho, sample_size = EXCLUDED.sample_size,
               calibration = EXCLUDED.calibration, info_factor = EXCLUDED.info_factor,
               updated_at = now()`,
        [agentId, model, rho, sampleSize, calibration, infoFactor],
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
    async upsertLearnedPrior(agentId, model, learnedPrior) {
      await db.query(
        `INSERT INTO legion.agent_reliability (agent_id, model, learned_prior, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (agent_id, model) DO UPDATE
           SET learned_prior = EXCLUDED.learned_prior, updated_at = now()`,
        [agentId, model, learnedPrior],
      );
    },

    // Roster watch (ADR 0028): how long each agent has sat at the rho floor.
    async getFlooredStreaks() {
      const rows = await db.query(
        `SELECT agent_id, model, floored_streak FROM legion.agent_reliability`,
      );
      return nestByAgentModel(rows, 'floored_streak');
    },

    async updateRosterFlag(agentId, model, streak, flagged) {
      await db.query(
        `UPDATE legion.agent_reliability
            SET floored_streak = $3, flagged = $4, updated_at = now()
          WHERE agent_id = $1 AND model = $2`,
        [agentId, model, streak, flagged],
      );
    },

    async getReliabilityLeaderboard() {
      const rows = await db.query(
        `SELECT agent_id, model, rho, sample_size, calibration, info_factor, learned_prior,
                floored_streak, flagged
           FROM legion.agent_reliability ORDER BY rho DESC`,
      );
      return rows.map((r) => ({
        agentId: r.agent_id,
        model: r.model,
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
        `SELECT sv.agent_id, sv.model, sv.stance, sv.conviction, s.outcome,
                s.forward_return, s.spy_return, s.regime
           FROM legion.signal_votes sv
           JOIN legion.signals s ON s.id = sv.signal_id
          WHERE s.resolved = true AND s.outcome IS NOT NULL
          ORDER BY s.id DESC
          LIMIT $1`,
        [limit],
      );
    },

    // Board rows for the Reliability Board v2: includes symbol, signal id, and
    // return columns needed to compute per-agent win/loss/alpha performance.
    // Rows ordered newest-first so callers can bucket per agent with a simple cap.
    // limit = WINDOW * (agent count headroom) — same pattern as getResolvedForecasts.
    async getAgentBoardRows(limit) {
      return db.query(
        `SELECT sv.agent_id, sv.model, s.id, s.symbol, sv.stance, sv.conviction, s.outcome,
                s.forward_return, s.spy_return
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
        `SELECT agent_id, model, rho FROM legion.agent_regime_reliability WHERE regime = $1`,
        [regime],
      );
      return nestByAgentModel(rows, 'rho');
    },

    async getRegimeCalibration(regime) {
      const rows = await db.query(
        `SELECT agent_id, model, calibration FROM legion.agent_regime_reliability WHERE regime = $1`,
        [regime],
      );
      return nestByAgentModel(rows, 'calibration');
    },

    async upsertRegimeReliability(agentId, regime, model, rho, sampleSize, calibration = 1.0) {
      await db.query(
        `INSERT INTO legion.agent_regime_reliability (agent_id, regime, model, rho, calibration, sample_size, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (agent_id, regime, model) DO UPDATE
           SET rho = EXCLUDED.rho, calibration = EXCLUDED.calibration,
               sample_size = EXCLUDED.sample_size, updated_at = now()`,
        [agentId, regime, model, rho, calibration, sampleSize],
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

    // Pending-row recency is judged per CYCLE, not per row: a slow cycle's
    // early votes and its one-shot risk constraint can be much older than the
    // staleness cutoff while the cycle is still alive (later rows keep arriving).
    // A cycle counts as active if ANY of its rows in EITHER table is recent —
    // then ALL its rows are loaded on recovery and spared by the sweep.
    async loadPendingVotes(since) {
      return db.query(
        `SELECT cycle_id, round, symbol, vote
           FROM legion.pending_votes
          WHERE cycle_id IN (
                  SELECT cycle_id FROM legion.pending_votes WHERE created_at >= $1
                  UNION
                  SELECT cycle_id FROM legion.pending_constraints WHERE created_at >= $1
                )
          ORDER BY cycle_id, round`,
        [since],
      );
    },

    async loadPendingConstraints(since) {
      return db.query(
        `SELECT cycle_id, round, symbol, payload
           FROM legion.pending_constraints
          WHERE cycle_id IN (
                  SELECT cycle_id FROM legion.pending_votes WHERE created_at >= $1
                  UNION
                  SELECT cycle_id FROM legion.pending_constraints WHERE created_at >= $1
                )
          ORDER BY cycle_id, round`,
        [since],
      );
    },

    async deletePendingCycle(cycleId) {
      await db.query(`DELETE FROM legion.pending_votes WHERE cycle_id = $1`, [cycleId]);
      await db.query(`DELETE FROM legion.pending_constraints WHERE cycle_id = $1`, [cycleId]);
    },

    async deletePendingBefore(cutoff) {
      // Whole abandoned cycles only (no recent row in either table) — never
      // individual old rows of a still-active cycle, which recovery still needs.
      await db.query(
        `DELETE FROM legion.pending_votes
          WHERE cycle_id NOT IN (
                  SELECT cycle_id FROM legion.pending_votes WHERE created_at >= $1
                  UNION
                  SELECT cycle_id FROM legion.pending_constraints WHERE created_at >= $1
                )`,
        [cutoff],
      );
      await db.query(
        `DELETE FROM legion.pending_constraints
          WHERE cycle_id NOT IN (
                  SELECT cycle_id FROM legion.pending_votes WHERE created_at >= $1
                  UNION
                  SELECT cycle_id FROM legion.pending_constraints WHERE created_at >= $1
                )`,
        [cutoff],
      );
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

    // Closes cycles abandoned mid-debate: still 'running' but started before
    // `cutoff` and not in `activeIds` (the cycles the emitter still tracks in
    // memory — alive however long ago they started). Returns the closed rows so
    // the caller can log what was given up on.
    async timeoutStaleCycles(cutoff, activeIds = []) {
      return db.query(
        `UPDATE legion.cycles
            SET status = 'timeout', ended_at = now()
          WHERE status = 'running'
            AND started_at < $1
            AND NOT (id = ANY($2::bigint[]))
         RETURNING id, symbol`,
        [cutoff, activeIds],
      );
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
        `SELECT agent_id, stance, conviction, weight, rationale, thought, model, source
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

    // Every emitted signal, oldest-first, for the quality-weighted paper book.
    // Deliberately NOT user-scoped: the research engine is shared (ADR 0030);
    // per-user filtering happens at the route via the user's watchlist.
    async listAllSignals() {
      const rows = await db.query(
        `SELECT id, symbol, band, conviction, plan, created_at,
                entry_price, spy_entry_price, qqq_entry_price, resolve_after
           FROM legion.signals ORDER BY created_at ASC`,
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

    // ── Multi-tenant web (ADR 0030) ─────────────────────────────────────────
    async upsertUser({ googleSub, email, name, avatarUrl }) {
      const row = await db.queryOne(
        `INSERT INTO legion.users (google_sub, email, name, avatar_url, last_login_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (google_sub) DO UPDATE
           SET email = EXCLUDED.email, name = EXCLUDED.name,
               avatar_url = EXCLUDED.avatar_url, last_login_at = now()
         RETURNING id, email, name, avatar_url`,
        [googleSub, email, name, avatarUrl],
      );
      return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
    },

    async getUserById(id) {
      const row = await db.queryOne(
        `SELECT id, email, name, avatar_url FROM legion.users WHERE id = $1`,
        [id],
      );
      if (!row) return null;
      return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
    },

    async listWatchlist(userId) {
      const rows = await db.query(
        `SELECT symbol FROM legion.user_watchlist WHERE user_id = $1 ORDER BY symbol`,
        [userId],
      );
      return rows.map((r) => r.symbol);
    },

    async addWatchlistSymbol(userId, symbol) {
      await db.query(
        `INSERT INTO legion.user_watchlist (user_id, symbol) VALUES ($1, $2)
         ON CONFLICT (user_id, symbol) DO NOTHING`,
        [userId, symbol.toUpperCase()],
      );
    },

    async removeWatchlistSymbol(userId, symbol) {
      await db.query(
        `DELETE FROM legion.user_watchlist WHERE user_id = $1 AND symbol = $2`,
        [userId, symbol.toUpperCase()],
      );
    },

    async getPortfolioConfig(userId) {
      const row = await db.queryOne(
        `SELECT starting_cash, horizon_days FROM legion.user_portfolio_config WHERE user_id = $1`,
        [userId],
      );
      if (!row) return null;
      return { startingCash: Number(row.starting_cash), horizonDays: row.horizon_days };
    },

    async upsertPortfolioConfig(userId, { startingCash, horizonDays }) {
      const row = await db.queryOne(
        `INSERT INTO legion.user_portfolio_config (user_id, starting_cash, horizon_days, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE
           SET starting_cash = EXCLUDED.starting_cash, horizon_days = EXCLUDED.horizon_days,
               updated_at = now()
         RETURNING starting_cash, horizon_days`,
        [userId, startingCash, horizonDays],
      );
      return { startingCash: Number(row.starting_cash), horizonDays: row.horizon_days };
    },

    // ── Quality-weighted sizing: real holdings (ADR 0032) ──────────────────────

    async listHoldings(userId) {
      const rows = await db.query(
        `SELECT id, ticker, asset_type, shares, avg_cost, total_cost, realized_pl,
                dividends, currency, notes, updated_at
           FROM legion.holdings WHERE user_id = $1 ORDER BY ticker`,
        [userId],
      );
      return rows.map((r) => ({
        id: r.id,
        ticker: r.ticker,
        assetType: r.asset_type,
        shares: Number(r.shares),
        avgCost: Number(r.avg_cost),
        totalCost: Number(r.total_cost),
        realizedPl: Number(r.realized_pl),
        dividends: Number(r.dividends),
        currency: r.currency,
        notes: r.notes ?? null,
        updatedAt: r.updated_at,
      }));
    },

    async upsertHolding(userId, { ticker, shares, avgCost, assetType = 'stock', notes = null }) {
      const totalCost = Number(shares) * Number(avgCost);
      const row = await db.queryOne(
        `INSERT INTO legion.holdings (user_id, ticker, asset_type, shares, avg_cost, total_cost, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id, ticker) DO UPDATE
           SET shares = EXCLUDED.shares, avg_cost = EXCLUDED.avg_cost,
               total_cost = EXCLUDED.total_cost, asset_type = EXCLUDED.asset_type,
               notes = EXCLUDED.notes, updated_at = now()
         RETURNING id, ticker, asset_type, shares, avg_cost, total_cost, realized_pl,
                   dividends, currency, notes, updated_at`,
        [userId, ticker.toUpperCase(), assetType, shares, avgCost, totalCost, notes],
      );
      return {
        id: row.id, ticker: row.ticker, assetType: row.asset_type,
        shares: Number(row.shares), avgCost: Number(row.avg_cost), totalCost: Number(row.total_cost),
        realizedPl: Number(row.realized_pl), dividends: Number(row.dividends),
        currency: row.currency, notes: row.notes ?? null, updatedAt: row.updated_at,
      };
    },

    async deleteHolding(userId, ticker) {
      const row = await db.queryOne(
        `DELETE FROM legion.holdings WHERE user_id = $1 AND ticker = $2 RETURNING id`,
        [userId, ticker.toUpperCase()],
      );
      return row != null;
    },

    // ── Global runtime config (ADR 0031) ───────────────────────────────────────
    // Generic key/value overrides, read per cycle and overlaid on the env-derived
    // config (see src/config/runtime-keys.js + runtime-overrides.js). Values are stored
    // as text; coercion lives in the overlay so the repo stays schema-agnostic.

    async getRuntimeConfig() {
      const rows = await db.query(`SELECT key, value FROM legion.runtime_config`);
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },

    async setRuntimeConfig(key, value) {
      await db.query(
        `INSERT INTO legion.runtime_config (key, value, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, String(value)],
      );
    },

    async deleteRuntimeConfig(key) {
      await db.query(`DELETE FROM legion.runtime_config WHERE key = $1`, [key]);
    },
  };
}
