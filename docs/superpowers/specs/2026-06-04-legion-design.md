# Project Legion — Distributed Multi-Agent Stock Signal Gestalt

**Status:** Design (approved for planning)
**Date:** 2026-06-04
**Author:** Gun Kaewngarm
**Related system:** GunVest (separate repo, shared infra)

---

## 1. Vision

Legion is a leaderless, multi-agent stock signal system inspired by the geth gestalt
(Mass Effect / "Legion"). Independent expert agents — each its own process — observe a
ticker, cast structured votes, expose each other to dissent, and iterate until a
**deterministic, leaderless consensus** emerges or a round cap is hit. The consensus is
emitted as a full trade plan to Telegram and a monitoring dashboard.

There is **no prime / core decider**. Every node independently computes the same
aggregation from the same broadcast votes (state-machine replication style), so consensus
is emergent and verifiable, not handed down by an arbiter.

### Non-goals

- No order execution (advisory only).
- No real adversarial Byzantine networking (agents are cooperative + co-located; see §3).
- No paid data or paid infra by default (runtime cost target ≈ $0).

---

## 2. Relationship to GunVest

- **Separate repository**, deployed on the **same Oracle Cloud A1 Always-Free VM**.
- **Shared PostgreSQL** instance, isolated in its own `legion` schema.
- **Reuses GunVest's REST API** as the sole data source for prices, news, sentiment,
  macro, geopolitical, earnings, and Inverse-Cramer. Legion never re-implements data
  fetching. GunVest stays the source of truth.
- **Reuses GunVest's Telegram** bot for signal + summary delivery.

---

## 3. Consensus Protocol (the core)

### 3.1 Framing — BFT-_flavored_, not adversarial BFT

True PBFT/Tendermint defends against nodes that lie across untrusted machines. Legion's
agents are cooperative and co-located, so Legion borrows BFT's **robustness + aesthetic**
(supermajority quorum, no leader, outlier tolerance) without the networking overhead.

### 3.2 Vote

Each agent `i`, per ticker, per round `r` emits:

- `stance s_i ∈ {-2 STRONG_SELL, -1 SELL, 0 HOLD, +1 BUY, +2 STRONG_BUY}` (ordinal)
- `conviction c_i ∈ [0,1]` (self-reported confidence)
- `rationale` (text — shown in dashboard, fed to peers as dissent)

### 3.3 Weights

`W_i = w_i · ρ_i`

- `w_i` — static domain prior (configurable per agent).
- `ρ_i` — dynamic reliability from backtest track record. Starts at `1.0`, updated via
  Brier score as signals resolve. This is how the gestalt learns which voices to trust.

### 3.4 Aggregation (computed identically by every node)

```
Weighted stance:     S_r = Σ(W_i · c_i · s_i) / Σ(W_i · c_i)        ∈ [-2, +2]
Weighted dispersion: V_r = Σ(W_i · c_i · (s_i − S_r)²) / Σ(W_i · c_i)
Directional quorum:  κ_r = weighted fraction of agents on sign(S_r)'s side
                          (HOLD band: |S_r| < 0.5 treated as neutral)
```

### 3.5 Convergence

Round `r` reaches consensus **iff both**:

```
κ_r ≥ 2/3        (Byzantine supermajority quorum)
V_r ≤ θ_v        (dispersion threshold, default θ_v = 0.5)
```

Fault tolerance: `f = ⌊(N−1)/3⌋`. For the launch roster of **N = 4 voting agents**,
`f = 1` → need ≥ `⌈2N/3⌉ = 3` weighted-agreeing agents; a single outlier can neither
force nor block consensus.

### 3.6 Iteration

If not converged, each agent receives the round's votes + the strongest **opposing**
rationales (forced dissent exposure) and re-votes in round `r+1`. Cap `R_max = 3` (config).

### 3.7 Termination

- **Converged** → emit signal: stance from `S_r` band, conviction from `|S_r|` × agreement.
- **`R_max` hit unconverged** → emit `NO_CONSENSUS` / HOLD, dispersion logged. Honest
  "split" beats a forced trade.

### 3.8 Risk Manager — deterministic safety constraint

The Risk Manager is a **non-voting constraint node** (launch config). After aggregation it
may **cap final conviction** or **block a BUY** when downside/volatility rules breach. It
constrains, it does not decide direction — leaderless purity preserved. Promotable to a
full voting node later via config.

### 3.9 Leaderless guarantee

A plain scheduler kicks off "evaluate NVDA" (orchestration, not a decision). Each agent
sees all votes over NATS and computes the **same** aggregation from the shared lib. Same
inputs → same output → no leader needed.

---

## 4. Agent Roster

### Launch (Lean 5)

| Agent                              | Role                                                              | Inputs (via GunVest API)            | Voting        |
| ---------------------------------- | ----------------------------------------------------------------- | ----------------------------------- | ------------- |
| **Technical** (+Quant)             | Price action, MA/RSI/MACD, S/R, trend, vol regime, mean-reversion | market/price                        | ✅            |
| **News/Catalyst** (+Macro/Geo)     | Breaking news, earnings, guidance, rates, war-room threat         | news, earnings, macro, geopolitical | ✅            |
| **Social Sentiment** (+Crowd-Fade) | StockTwits + Reddit mood/volume; Inverse-Cramer slot (pluggable)  | sentiment, cramer                   | ✅            |
| **Contrarian**                     | Devil's advocate + real contrarian data (see §4.1)                | contrarian feeds + peer votes       | ✅            |
| **Risk Manager**                   | Downside, volatility, position sizing, stops                      | market, macro, portfolio            | ❌ constraint |

### Add-later (designed as drop-in modules)

Standalone Quant, standalone Macro/Geopolitical, standalone Crowd-Fade/Inverse-Cramer.
Enable any via `config.json` — no core changes.

### 4.1 Contrarian data feeds (free, pluggable, degrade gracefully)

- **CBOE put/call ratio** (daily) — high = fear = contrarian-bullish.
- **AAII bull/bear survey** + **NAAIM exposure** (weekly).
- **CNN Fear & Greed** (equities; crypto F&G already in GunVest via Alternative.me).
- **Short interest** (Finnhub free / FINRA) — crowded shorts = squeeze fuel.
- **VIX / VIX term structure** (GunVest macro).

Logic: extreme greed → lean bearish; extreme fear → lean bullish; always argues against
the forming consensus using peer votes.

---

## 5. Architecture

```
                         Oracle A1 VM (Docker)
 ┌──────────────────────────────────────────────────────────────┐
 │  legion-orchestrator (cron: kicks ticker cycles — NOT a decider)│
 │        │ publishes legion.cycle.<ticker>                        │
 │        ▼                                                        │
 │   ┌─────────── NATS (message bus / gossip) ───────────┐        │
 │   │  subjects: legion.cycle.*  legion.vote.*  legion.consensus.* │
 │   └──▲────▲────▲────▲────▲──────────────────────────────┘        │
 │      │    │    │    │    │   (5 independent processes)           │
 │    tech  news social contra risk                                 │
 │      each: subscribe cycle → pull data → LLM vote → publish      │
 │            subscribe votes → compute aggregation locally          │
 │                             │                                    │
 │                             ▼ on consensus                       │
 │   legion-emitter → Postgres(legion schema) + Telegram + WS       │
 └──────────────────────────────────────────────────────────────┘
        │ reads market/news/sentiment via HTTP            ▲
        ▼                                                 │
   gunvest REST API  ──────────────────────────► shared Postgres
                                                  (separate `legion` schema)
   legion-web (dashboard: debate viewer, ticker config, backtest)
```

- **5 agents = 5 separate processes/containers** (1-agent-per-module).
- **One Ollama container** serves the local LLM; agents queue (serial throughput).
  Cycle time ≈ agents × rounds × per-call latency (~12–15 min/ticker at launch).
- **NATS** message bus (lightweight pub/sub, Docker on the VM).
- **legion schema** tables: `tickers`, `cycles`, `rounds`, `votes`, `signals`,
  `agent_reliability`, `backtest_results`.

---

## 6. Agent Module Contract

```
agents/<name>/
  index.js     // subscribe(cycle) → gather() → reason() → vote()
  prompt.js    // persona / expert system prompt
  gather.js    // which GunVest endpoints/inputs it pulls
  config.json  // w_i prior weight, data deps, enabled flag, provider
```

- **Pluggable LLM provider** (`llm/provider.js`): `local` (Ollama, default), `gemini`,
  `openai` — switchable per-agent via config/UI.
- **Pluggable social/contrarian sources** behind interfaces (X drops in later if paid).
- **Aggregation in a shared lib** (`consensus/aggregate.js`) imported by all nodes —
  single source of math truth, heavily unit-tested.

### Inference strategy

Local-first on Oracle A1 (Qwen2.5-7B-Instruct or Llama-3.1-8B, Q4, via Ollama).
Gemini API (free tier) and paid providers selectable per-agent. Note: ARM CPU inference is
slow (~5–10 tok/s) and weaker than hosted — acceptable for 6h batch cadence; per-ticker
alerts lag a few minutes.

---

## 7. Dashboard (legion-web)

- **Debate Viewer** — pick ticker → cycles → expand rounds → each agent's
  stance/conviction/rationale per round, live `S_r / V_r / κ_r` and convergence status.
- **Ticker Config** — add/remove tickers, enable/disable agents, set provider, tune
  `w_i`, `θ_v`, `R_max`.
- **Backtest** — signal hit-rate + cumulative P&L vs SPY/QQQ; deterministic sub-signal
  history; per-agent reliability `ρ_i` leaderboard.
- Stack: React + Vite + Tailwind (mirrors GunVest frontend), own app.

---

## 8. Signal Output

Full trade plan: direction + conviction + entry/stop/target (Technical/Risk) +
position-size suggestion (GunVest portfolio context) + time horizon + per-agent rationale.
Delivered to Telegram on consensus; 6h summary aggregates the window's signals.

---

## 9. Backtesting

- **Forward paper-test (primary):** log every live signal, track forward returns vs
  SPY/QQQ (hit-rate, P&L).
- **Deterministic backtest:** replay the technical/quant _deterministic_ sub-signals over
  history (no LLM in the loop — cheap, reproducible).
- **Reliability loop:** as signals resolve, update each agent's `ρ_i` via Brier score.
- **Explicitly not doing:** re-running multi-agent LLM debates over history (too slow on
  local CPU, non-deterministic).

---

## 10. Phasing (each milestone = handover doc for clean session resume)

| Phase                        | Deliverable                                                                                                                                    | Rationale                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **0 Foundation**             | Repo, Docker, NATS, `legion` schema, shared vote-schema + aggregation lib (unit-tested), LLM provider abstraction (Ollama), GunVest API client | De-risk math + plumbing first |
| **1 Single agent E2E**       | Technical agent → vote → emitter → Telegram, 1 ticker                                                                                          | Prove the pipeline            |
| **2 Consensus**              | Add News, Social, Contrarian + Risk constraint; rounds/iteration/convergence; multi-ticker                                                     | Core gestalt                  |
| **3 Dashboard**              | Debate viewer, ticker config, signal feed                                                                                                      | See it work                   |
| **4 Backtest + reliability** | Forward paper-test, index compare, deterministic backtest, `ρ_i` loop                                                                          | Measure + self-tune           |
| **5 Summary + polish**       | 6h Telegram summary, provider-switch UI, add-agent docs, ADRs                                                                                  | Ship                          |

Development uses caveman-compressed implementation + subagent-driven builds to bound token
cost. A handover note is written at each milestone boundary.

---

## 11. Cost

| Item                                                             | Cost     |
| ---------------------------------------------------------------- | -------- |
| Infra (Oracle A1 Always-Free: NATS, Ollama, agents, web)         | $0       |
| PostgreSQL (shared with GunVest)                                 | $0       |
| LLM (local default; Gemini free-tier optional; paid opt-in only) | $0       |
| Data (all via GunVest free APIs; X skipped)                      | $0       |
| Telegram                                                         | $0       |
| **Runtime total**                                                | **≈ $0** |

Only cost is development tokens, bounded by phasing + caveman + subagents.

---

## 12. Open / Deferred

- Twitter/X social source — deferred (paid API); pluggable slot reserved.
- Promote Risk Manager to voting node — config flag, post-launch.
- Parallel LLM throughput (multiple model servers) — only if ticker count grows.
- ADRs to be written per subsystem during implementation (consensus, message bus,
  inference abstraction, deployment).
