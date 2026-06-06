# Legion

**A leaderless, multi-agent stock-signal engine.** Independent expert agents each look at a
ticker, cast a structured vote, are forced to confront each other's dissent, and iterate
until a *deterministic* consensus emerges — or they honestly agree to disagree. The result
is delivered as a trade plan to Telegram and a dashboard.

Inspired by the geth gestalt in *Mass Effect* ("Legion"): no single mind decides. Many
narrow intelligences vote, and the agreement is the intelligence.

> Full design: [`docs/superpowers/specs/2026-06-04-legion-design.md`](docs/superpowers/specs/2026-06-04-legion-design.md)

---

## Why it exists

A single LLM asked "should I buy NVDA?" gives you one opinion with one set of blind spots.
Legion's bet is that a **diverse panel that argues** is more honest than any one model:

- **Holistic** — price action, breaking news/macro, social mood, and a dedicated
  contrarian are weighed *together*, not cherry-picked.
- **Leaderless / verifiable** — there is **no prime decider**. Every node receives the same
  votes over the message bus and runs the *same* aggregation math, so the consensus is
  emergent and reproducible (state-machine-replication style), not handed down by an
  arbiter.
- **Self-tuning** — each agent carries a reliability weight `ρ_i` that rises or falls with
  its backtested track record. The gestalt learns which voices to trust.
- **≈ $0 runtime** — local LLM (Ollama) on an Oracle Always-Free VM, all data reused from
  the existing GunVest API, Telegram for delivery. The only real cost is development.

It is **advisory only** — Legion never places orders.

---

## How it works (one cycle)

```
 orchestrator ──kick──▶ legion.cycle.NVDA ──▶ ┌─ technical ─┐
 (cron, NOT a decider)                        ├─ news       ┤ each: gather data → ask LLM →
                                              ├─ social     ┤        publish a structured vote
                                              ├─ contrarian ┤
                                              └─ risk* ──────┘ (*non-voting: a constraint)
                                                     │
                          legion.vote.NVDA.<round>   ▼
                                              ┌───────────────┐
                                              │    emitter    │  collects votes → runs the
                                              │  (aggregation)│  shared consensus math
                                              └───────────────┘
                                                     │
                       converged?  ──no──▶ re-publish the cycle (round+1) with peers' dissent
                              │ yes
                              ▼
              persist (Postgres) → Telegram signal → legion.consensus.NVDA
```

Each agent is its **own process**, talking only over [NATS](https://nats.io). There is no
shared memory and no coordinator — agents are interchangeable and independently
restartable. A plain cron "kick" is orchestration, not a decision.

---

## The consensus math

This is the core of the project, so it is worth understanding. All of it lives in one
heavily unit-tested module: [`src/consensus/aggregate.js`](src/consensus/aggregate.js).

### A vote

Every agent `i`, per ticker, per round, emits:

| Field | Symbol | Range | Meaning |
|---|---|---|---|
| stance | `s_i` | `-2, -1, 0, +1, +2` | STRONG_SELL · SELL · HOLD · BUY · STRONG_BUY (ordinal) |
| conviction | `c_i` | `0 … 1` | the agent's self-reported confidence |
| rationale | — | text | shown in the dashboard, and fed to peers as dissent next round |

### Weights

Each agent's effective weight combines a static prior with a learned reliability:

```
W_i = w_i · ρ_i
```

- `w_i` — **domain prior**, fixed per agent (see the roster table below).
- `ρ_i` — **reliability**, starts at `1.0` and is updated from the agent's Brier score as
  past signals resolve (Phase 4). Good forecasters gain weight; poor ones lose it.

### Aggregation (every node computes this identically)

For a round's votes, with `W_i·c_i` as the effective influence of agent `i`:

```
Weighted stance       S = Σ(W_i · c_i · s_i) / Σ(W_i · c_i)            ∈ [−2, +2]
Weighted dispersion   V = Σ(W_i · c_i · (s_i − S)²) / Σ(W_i · c_i)     ≥ 0
Directional quorum    κ = Σ(W_i · c_i  over agents on sign(S)'s side) / Σ(W_i · c_i)   ∈ [0, 1]
```

- **`S`** is *where* the panel leans (the conviction-and-weight-weighted average stance).
- **`V`** is *how much they disagree* — a confident split has high `V`; near-unanimity has
  low `V`.
- **`κ`** is *what fraction of the weight* sits on the winning side. When the panel is
  near-neutral (`|S| < holdBand`, default `0.5`), agents voting HOLD are also counted as
  agreeing — a flat consensus should credit the agents that actually sat flat, not just the
  marginal lean.

### Convergence

A round reaches consensus **only if both** hold:

```
κ ≥ 2/3        (a Byzantine-style supermajority is on the same side)
V ≤ θ_v        (dispersion is low enough — default θ_v = 0.5)
```

Requiring **both** is deliberate: a bare majority that is loudly split (`κ` high but `V`
high) is *not* consensus. With the launch roster of `N = 4` voting agents the fault
tolerance is `f = ⌊(N−1)/3⌋ = 1` — a single outlier can neither force nor block a
decision.

### From score to signal

On convergence the score becomes a label and a conviction
([`src/consensus/stance.js`](src/consensus/stance.js), [`src/emit/plan.js`](src/emit/plan.js)):

```
band(S):  |S| < 0.5 → HOLD
          |S| ≥ 1.5 → STRONG_BUY / STRONG_SELL
          else      → BUY / SELL
conviction = min(|S| / 2, 1)        # the [−2,2] score normalized to [0,1]
```

A non-converged final round emits `NO_CONSENSUS` (conviction 0). An honest "we're split"
beats a forced trade.

### Worked example

Round 1 on NVDA, four agents (`θ_v = 0.5`, `quorum = 2/3`, all `ρ_i = 1`):

| agent | `w_i` | stance `s_i` | conviction `c_i` | `W_i·c_i` |
|---|---|---|---|---|
| technical | 1.0 | +2 | 0.9 | 0.90 |
| news | 1.2 | +2 | 0.8 | 0.96 |
| social | 0.8 | +1 | 0.6 | 0.48 |
| contrarian | 0.9 | −1 | 0.5 | 0.45 |

```
Σ W·c = 2.79
S = (0.90·2 + 0.96·2 + 0.48·1 + 0.45·(−1)) / 2.79 = 3.75 / 2.79 ≈ +1.34   → band BUY
V = (0.90·0.66² + 0.96·0.66² + 0.48·0.34² + 0.45·2.34²) / 2.79 ≈ 1.19
κ = (0.90 + 0.96 + 0.48) / 2.79 ≈ 0.84        # the three bulls
```

`κ = 0.84 ≥ 0.67` ✅ **but** `V = 1.19 > 0.5` ❌ → **not converged.** The contrarian's
strong dissent keeps dispersion high. So the round does **not** emit; instead it
**iterates**.

### Iteration & forced dissent

When a round fails to converge, the emitter re-publishes the cycle with `round + 1` and the
prior round's votes attached. Each agent is shown the **strongest opposing rationales** and
re-votes — it may hold its ground or move. This repeats until convergence or `R_max`
(default 3) rounds, at which point an unresolved panel emits `NO_CONSENSUS`. (Multi-round
iteration and the extra agents land in Phase 2; see Status.)

### The Risk Manager (a constraint, not a vote)

The Risk Manager is **non-voting**. It never enters the aggregation. After consensus it may
**cap conviction** or **block a new long** on volatility/downside rules — it constrains
magnitude and entry, but **never flips direction**. Leaderless purity is preserved: risk
limits the trade, it doesn't decide it.

---

## Agent roster

| Agent | Prior `w_i` | Looks at | Votes? | Why this weight |
|---|---|---|---|---|
| **Technical** (+Quant) | 1.0 | price action, trend, momentum, volatility | ✅ | baseline |
| **News / Catalyst** (+Macro) | 1.2 | headlines, earnings/guidance, rates, VIX | ✅ | catalysts move price hard |
| **Social Sentiment** | 0.8 | StockTwits / Reddit mood & volume | ✅ | informative but herd-prone |
| **Contrarian** | 0.9 | crowd positioning, VIX; fades extremes | ✅ | a deliberate counterweight |
| **Risk Manager** | — | volatility, downside, sizing | ❌ | deterministic safety constraint |

Adding an agent is config + a `gather` function + a persona prompt — every voting agent
shares one runner. The contrarian pulls a live crowd-positioning panel via `src/data/feeds/`:
Fear & Greed + VIX (GunVest REST), put/call (CNN `graphdata`), AAII (aaii.com scrape), NAAIM
(YCharts scrape), short interest (Finnhub). Each source is isolated and degrades to `null` on
failure, so a dead upstream never blocks a vote.

---

## Status

| Phase | Deliverable | State |
|---|---|---|
| **0 Foundation** | repo, Docker, NATS, `legion` schema, consensus + vote libs, LLM provider, GunVest client | ✅ done |
| **1 Single agent E2E** | Technical agent → vote → emitter → Telegram, one ticker | ✅ done |
| **2 Consensus** | News / Social / Contrarian + Risk constraint, multi-round iteration, multi-ticker | ✅ done |
| **3 Dashboard** | debate viewer, ticker config, signal feed | ▫ planned |
| **4 Backtest + reliability** | forward paper-test, index compare, `ρ_i` loop | ▫ planned |
| **5 Summary + polish** | 6h Telegram summary, provider-switch UI, docs | ▫ planned |

Phase plans live in [`docs/superpowers/plans/`](docs/superpowers/plans/); per-milestone
handover notes in [`docs/superpowers/handovers/`](docs/superpowers/handovers/).

---

## Quick start

> Full local-stack walkthrough (infra, migrate, seed, run every process, verify,
> troubleshoot): **[docs/RUNNING.md](docs/RUNNING.md)**.

**Prerequisites:** Node.js ≥ 18 · Docker (NATS + Ollama) · a running GunVest instance
(REST API + PostgreSQL).

```bash
cp .env.example .env       # fill in values (see below)
npm install
docker compose up -d       # start NATS + Ollama
docker exec -it legion-ollama ollama pull qwen2.5:7b-instruct
npm run db:migrate         # create the legion schema in GunVest's Postgres
npm test                   # full suite, infra-free
```

### Run the Phase 2 gestalt

Seed at least one enabled ticker:

```sql
INSERT INTO legion.tickers (symbol, enabled) VALUES ('NVDA', true)
ON CONFLICT (symbol) DO UPDATE SET enabled = true;
```

Each role is its own process (NATS + Ollama + GunVest + Postgres must be up):

```bash
npm run emitter            # waits for 4 votes + the risk constraint per round
npm run agent:technical
npm run agent:news
npm run agent:social
npm run agent:contrarian   # real crowd-positioning feeds (F&G, VIX, put/call, AAII, NAAIM, short interest)
npm run risk               # non-voting deterministic constraint node
npm run scheduler -- --now # kicks every enabled ticker immediately
```

Or bring the whole topology up with Docker: `docker compose up -d`.

A consensus signal (or `NO_CONSENSUS`) lands in Telegram per ticker, and `legion.rounds`
holds every round of the debate for the dashboard.

---

## Configuration

Consensus thresholds (env, read by [`src/config/index.js`](src/config/index.js)):

| Var | Default | Meaning |
|---|---|---|
| `CONSENSUS_THETA_V` | `0.5` | max dispersion `V` allowed for convergence |
| `CONSENSUS_QUORUM` | `0.6667` | min directional quorum `κ` (2/3 supermajority) |
| `CONSENSUS_MAX_ROUNDS` | `3` | round cap before `NO_CONSENSUS` |
| `CONSENSUS_HOLD_BAND` | `0.5` | neutral half-width: `|S| < this` ⇒ HOLD |

Delivery / pipeline:

| Var | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | signal delivery (reuses GunVest's bot) |
| `LEGION_EXPECTED_AGENTS` | votes the emitter waits for before evaluating (4 in Phase 2) |
| `LEGION_RISK_ENABLED` | require the risk constraint before finalizing (`true` by default) |
| `LEGION_CRON` | scheduler cadence (default `0 */6 * * *`, every 6h) |
| `FINNHUB_API_KEY` | Enables the Contrarian short-interest feed only; copy from GunVest. The other feeds (F&G, VIX, put/call, AAII, NAAIM) are live without it; short interest returns null when unset |

LLM provider is pluggable (`local` Ollama by default; `gemini` / `openai` selectable per
agent) via [`src/llm/provider.js`](src/llm/provider.js).

---

## Architecture notes

- **Five agents = five processes/containers**, 1-agent-per-module. One Ollama container
  serves the local model; agents queue serially, so a cycle is roughly
  `agents × rounds × per-call latency` (~12–15 min/ticker on the A1 VM).
- **Shared Postgres**, isolated `legion` schema: `tickers`, `cycles`, `rounds`, `votes`,
  `signals`, `agent_reliability`, `backtest_results`. Every round is persisted so the
  dashboard can replay the debate.
- **All data via GunVest** — Legion never re-implements fetching. GunVest stays the source
  of truth for prices, news, sentiment, macro.
- **Tests are infra-free**: a fake `pg` pool, a stubbed LLM, and an in-memory bus double
  (NATS-style wildcards) drive the whole pipeline — no broker or DB needed in CI.

## Repository layout

```
src/
  bus/          NATS subjects + JSON wrapper, in-memory bus double
  consensus/    vote schema, stance helpers, aggregation math (the core)
  agents/       per-agent gather / prompt / parse / runner
  emit/         signal builder, Telegram client, emitter (runs consensus)
  risk/         (Phase 2) non-voting risk constraint
  db/           schema, client, repository, migrations
  llm/          pluggable provider (Ollama)
  data/         GunVest REST client
  run/          process entrypoints (orchestrator, agents, emitter)
docs/superpowers/  design spec, phase plans, handover notes
test/           mirrors src/, infra-free
```

---

## Cost

Infra (Oracle A1 Always-Free), Postgres (shared), LLM (local, or Gemini free tier),
data (GunVest free APIs), Telegram — **all $0**. Runtime total ≈ **$0**. The only cost is
development tokens, bounded by phasing.

---

## Phase 3 — dashboard

Backend API (serves the `legion` schema):

```bash
npm run api          # http://localhost:8088
```

Frontend (separate app in web/):

```bash
cd web
npm install
npm run dev          # http://localhost:5174 (proxies /api to :8088)
```

Tabs: **Signals** (latest calls), **Debate** (pick a ticker → cycle → rounds with S/V/κ and per-agent votes), **Config** (add/enable/disable tickers the scheduler monitors).
