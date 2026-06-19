CREATE SCHEMA IF NOT EXISTS legion;

-- Tickers Legion monitors.
CREATE TABLE IF NOT EXISTS legion.tickers (
  symbol      TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One evaluation cycle per ticker kick-off.
CREATE TABLE IF NOT EXISTS legion.cycles (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL REFERENCES legion.tickers(symbol),
  status      TEXT NOT NULL DEFAULT 'running',  -- running | converged | no_consensus | timeout
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);

-- One row per debate round within a cycle.
CREATE TABLE IF NOT EXISTS legion.rounds (
  id          BIGSERIAL PRIMARY KEY,
  cycle_id    BIGINT NOT NULL REFERENCES legion.cycles(id) ON DELETE CASCADE,
  round_no    INT NOT NULL,
  s_score     NUMERIC(10,6),   -- S_r
  dispersion  NUMERIC(10,6),   -- V_r
  quorum      NUMERIC(10,6),   -- κ_r
  converged   BOOLEAN,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, round_no)
);

-- Individual agent votes per round.
CREATE TABLE IF NOT EXISTS legion.votes (
  id          BIGSERIAL PRIMARY KEY,
  round_id    BIGINT NOT NULL REFERENCES legion.rounds(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  stance      INT NOT NULL,
  conviction  NUMERIC(6,4) NOT NULL,
  weight      NUMERIC(10,6) NOT NULL,
  rationale   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emitted signals (the trade plan).
CREATE TABLE IF NOT EXISTS legion.signals (
  id          BIGSERIAL PRIMARY KEY,
  cycle_id    BIGINT NOT NULL REFERENCES legion.cycles(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  band        TEXT NOT NULL,            -- STRONG_SELL..STRONG_BUY | NO_CONSENSUS
  conviction  NUMERIC(6,4) NOT NULL,
  plan        JSONB NOT NULL,           -- entry/stop/target/size/horizon/rationale
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-agent reliability (ρ_i), updated by the backtest loop in a later phase.
CREATE TABLE IF NOT EXISTS legion.agent_reliability (
  agent_id      TEXT PRIMARY KEY,
  reliability   NUMERIC(6,4) NOT NULL DEFAULT 1.0,
  brier_score   NUMERIC(8,6),
  sample_count  INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Forward paper-test + deterministic backtest results.
CREATE TABLE IF NOT EXISTS legion.backtest_results (
  id          BIGSERIAL PRIMARY KEY,
  signal_id   BIGINT REFERENCES legion.signals(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  horizon     TEXT NOT NULL,
  signal_return  NUMERIC(10,6),
  index_return   NUMERIC(10,6),
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Phase 4: reliability + backtest ──────────────────────────────────────────

-- Extend the Phase 0 agent_reliability stub with the Brier-loop columns.
-- rho = clamp(1 + 2*(0.25 - meanBrier), 0.5, 1.5); sample_size = forecasts scored.
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS rho          DOUBLE PRECISION NOT NULL DEFAULT 1.0;
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS sample_size  INTEGER NOT NULL DEFAULT 0;
-- calibration = clamp(1 + (meanConviction(hits) - meanConviction(misses)), 0.5, 1.5);
-- scales the conviction term c_i (vs rho, which scales the prior w_i). See ADR 0014.
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS calibration  DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- Per-agent forecast snapshot taken when a signal is emitted (denormalized).
CREATE TABLE IF NOT EXISTS legion.signal_votes (
  signal_id    BIGINT NOT NULL REFERENCES legion.signals(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  stance       INTEGER NOT NULL,
  conviction   DOUBLE PRECISION NOT NULL,
  weight       DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (signal_id, agent_id)
);

-- Extend the Phase 0 backtest_results stub with deterministic-backtest aggregates.
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS strategy  TEXT NOT NULL DEFAULT 'deterministic-quant';
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS trades    INTEGER;
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS hits      INTEGER;
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS hit_rate  DOUBLE PRECISION;
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS pnl       DOUBLE PRECISION;
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS spy_pnl   DOUBLE PRECISION;
ALTER TABLE legion.backtest_results ADD COLUMN IF NOT EXISTS qqq_pnl   DOUBLE PRECISION;

-- Resolution columns on signals: forward paper-test outcome vs SPY/QQQ.
-- (Signal direction is derived from signals.band; no stance column is added.)
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS entry_price    DOUBLE PRECISION;
-- Benchmark prices captured in the same instant as entry_price, so the forward
-- paper-test measures stock and benchmarks from a shared "entered at signal time"
-- base (ADR 0009). Null on legacy signals -> resolver falls back to close-to-close.
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS spy_entry_price DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS qqq_entry_price DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS horizon_days   INTEGER NOT NULL DEFAULT 5;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS resolve_after  TIMESTAMPTZ;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS resolved       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS forward_return DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS spy_return     DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS qqq_return     DOUBLE PRECISION;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS outcome        INTEGER;
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS correct        BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_signals_unresolved
  ON legion.signals (resolve_after) WHERE resolved = false;

-- ── Phase 5: per-agent provider config ───────────────────────────────────────
-- Lets the dashboard switch each agent's LLM provider/model and mute agents
-- without a redeploy. Resolved per cycle by the agent factory.
CREATE TABLE IF NOT EXISTS legion.agent_config (
  agent_id   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL DEFAULT 'local',
  model      TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Phase 6: agent vote co-movement ───────────────────────────────────────────
-- Pairwise historical correlation of agents' stances (ADR 0015), recomputed by
-- the reliability loop. Used to discount redundant agreement in the quorum so a
-- cluster of co-moving agents counts as fewer independent confirmations.
CREATE TABLE IF NOT EXISTS legion.agent_correlation (
  agent_a      TEXT NOT NULL,
  agent_b      TEXT NOT NULL,
  corr         DOUBLE PRECISION NOT NULL,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_a, agent_b)
);

-- ── Phase 7: consensus diagnostics ───────────────────────────────────────────
-- Agreement strength A — prior-weighted mean conviction of the agreeing side
-- (IMPROVEMENT-PLAN §2.2). Measured per round, not gated on; collected so the
-- resolver data can answer whether low-A converged signals underperform before
-- any gate is added.
ALTER TABLE legion.rounds ADD COLUMN IF NOT EXISTS agreement DOUBLE PRECISION;

-- Information factor (ADR 0021): conviction discount for near-constant voters
-- whose stance variance carries no signal. Neutral 1.0; floors at 0.25.
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS info_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- ── Phase 8: regime-conditional reliability (ADR 0023) ───────────────────────
-- The market regime captured when the signal fired (calm | stressed | unknown,
-- from VIX). Lets the learner grade each agent per regime instead of averaging
-- its edge away.
ALTER TABLE legion.signals ADD COLUMN IF NOT EXISTS regime TEXT;

-- Per-(agent, regime) dials, recomputed by the reliability cron alongside the
-- unconditional ones. Rows exist only for buckets with >= MIN_RESOLVED resolved
-- forecasts, so the emitter's overlay falls back to the unconditional dials for
-- thin buckets.
CREATE TABLE IF NOT EXISTS legion.agent_regime_reliability (
  agent_id     TEXT NOT NULL,
  regime       TEXT NOT NULL,
  rho          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  calibration  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, regime)
);

-- ── Phase 9: emitter crash recovery (ADR 0024) ───────────────────────────────
-- Mirror of the emitter's in-memory round buffers. Rows live only while a cycle
-- is in flight: deleted on finalize, aged out past the stale-entry horizon.
CREATE TABLE IF NOT EXISTS legion.pending_votes (
  cycle_id    BIGINT NOT NULL,
  round       INT NOT NULL,
  symbol      TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  vote        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, round, agent_id)
);

CREATE TABLE IF NOT EXISTS legion.pending_constraints (
  cycle_id    BIGINT NOT NULL,
  round       INT NOT NULL,
  symbol      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, round)
);

-- ── Phase 10: meta-reflection lessons (ADR 0026) ─────────────────────────────
-- One distilled lesson per agent, written by the reflection pass from its
-- recent missed calls and injected into the agent's future prompts.
CREATE TABLE IF NOT EXISTS legion.agent_lessons (
  agent_id     TEXT PRIMARY KEY,
  lesson       TEXT NOT NULL,
  sample_size  INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Learned domain prior (ADR 0027): long-uniform-window skill score — the number
-- the hand-set w_i is guessing at. Measured and surfaced; not yet applied.
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS learned_prior DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- Roster watch (ADR 0028): consecutive recomputes an agent has spent pinned at
-- the rho floor, and the review flag raised when the streak persists. The
-- system never auto-retires — a human decides on the Agents tab.
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS floored_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE legion.agent_reliability ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false;

-- ── Multi-tenant web (ADR 0030) ──────────────────────────────────────────────
-- Authenticated dashboard users (Google OAuth). The research engine stays
-- shared; only watchlist + portfolio config below are per-user.
CREATE TABLE IF NOT EXISTS legion.users (
  id            BIGSERIAL PRIMARY KEY,
  google_sub    TEXT UNIQUE NOT NULL,   -- Google's stable subject id
  email         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- connect-pg-simple session store. Columns are fixed by that library.
CREATE TABLE IF NOT EXISTS legion.user_session (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_session_expire ON legion.user_session (expire);

-- Symbols a user follows (subset of the global roster). Engine still evaluates
-- the full legion.tickers roster; this only filters that user's dashboard.
CREATE TABLE IF NOT EXISTS legion.user_watchlist (
  user_id  BIGINT NOT NULL REFERENCES legion.users(id) ON DELETE CASCADE,
  symbol   TEXT NOT NULL REFERENCES legion.tickers(symbol),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

-- Per-user simulated-portfolio knobs. The sim stays deterministic (no stored
-- positions): config + the user's watchlist fully determine the replay.
CREATE TABLE IF NOT EXISTS legion.user_portfolio_config (
  user_id       BIGINT PRIMARY KEY REFERENCES legion.users(id) ON DELETE CASCADE,
  starting_cash NUMERIC(14,2) NOT NULL DEFAULT 100000,
  horizon_days  INTEGER NOT NULL DEFAULT 5,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── PC model server: per-(agent, model) reliability segmentation ──────────────
-- The served model is tagged on every signal vote so the learner can earn a
-- separate track record per model. Existing rows backfill to the Oracle model
-- (the only model that produced them) via the column default.
ALTER TABLE legion.signal_votes
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct';

ALTER TABLE legion.agent_reliability
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct';
ALTER TABLE legion.agent_regime_reliability
  ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'qwen2.5:7b-instruct';

-- Re-key the dial tables to include model. Guarded so re-running the schema is a
-- no-op once the composite key is in place.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_reliability_pkey'
       AND (SELECT array_length(conkey, 1) FROM pg_constraint
             WHERE conname = 'agent_reliability_pkey') = 1
  ) THEN
    ALTER TABLE legion.agent_reliability DROP CONSTRAINT agent_reliability_pkey;
    ALTER TABLE legion.agent_reliability ADD PRIMARY KEY (agent_id, model);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_regime_reliability_pkey'
       AND (SELECT array_length(conkey, 1) FROM pg_constraint
             WHERE conname = 'agent_regime_reliability_pkey') = 2
  ) THEN
    ALTER TABLE legion.agent_regime_reliability DROP CONSTRAINT agent_regime_reliability_pkey;
    ALTER TABLE legion.agent_regime_reliability ADD PRIMARY KEY (agent_id, regime, model);
  END IF;
END $$;

-- Global runtime flags editable from the dashboard (e.g. the home-PC kill switch).
CREATE TABLE IF NOT EXISTS legion.runtime_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
