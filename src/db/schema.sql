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
  status      TEXT NOT NULL DEFAULT 'running',  -- running | converged | no_consensus
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
