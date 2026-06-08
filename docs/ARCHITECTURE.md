# Legion Architecture

Legion turns a panel of independent LLM "expert" agents into a single, reproducible trade
stance. There is **no prime decider**: every process sees the same votes over a message bus and
runs the *same* aggregation math, so the consensus is emergent and verifiable. This document
describes how the pieces fit together at runtime. The *why* behind each choice lives in the
[Architecture Decision Records](#architecture-decision-records).

All diagrams below are [Mermaid](https://mermaid.js.org/) and render directly on GitHub.

---

## 1. System context

Legion is a read-only consumer of GunVest (data, database, Telegram) and runs entirely on the
same Oracle A1 VM (ADR 0007, ADR 0004).

```mermaid
flowchart LR
    user["Operator"]

    subgraph legion["Legion"]
        web["Web SPA<br/>(React + Vite)"]
        api["Read API<br/>(Express)"]
        pipe["Signal pipeline<br/>(orchestrator, agents,<br/>risk, emitter, crons)"]
        ollama["Ollama<br/>(local LLM)"]
    end

    subgraph gunvest["GunVest (shared)"]
        gvapi["GunVest REST API"]
        gvdb[("PostgreSQL<br/>legion schema")]
        gvtg["Telegram bot"]
    end

    user -->|browses| web
    web -->|"/api"| api
    api -->|reads| gvdb
    pipe -->|reads market/news/sentiment| gvapi
    pipe -->|inference| ollama
    pipe -->|persists cycles & signals| gvdb
    pipe -->|delivers signals| gvtg
    gvtg -->|message| user
```

Legion never fetches market data itself; the single client seam is `src/data/gunvest.js`. Its
own state lives in an isolated `legion` schema inside GunVest's database.

---

## 2. Runtime components and message flow

Each box is a separate process (a Docker Compose service) communicating only over NATS subjects
(ADR 0002). The **emitter** drives the multi-round debate; the **scheduler** only kicks round 1.

```mermaid
flowchart TB
    scheduler["scheduler<br/>(cron, every 4h)"]
    trigger["POST /api/trigger<br/>(on demand)"]
    orchestrator["orchestrator"]

    subgraph agents["Voting agents (×4)"]
        technical["technical"]
        news["news"]
        social["social"]
        contrarian["contrarian"]
    end

    risk["risk node<br/>(deterministic)"]
    emitter["emitter<br/>(aggregator)"]
    gunvest["GunVest API"]
    ollama["Ollama"]
    db[("legion schema")]
    tg["Telegram"]

    scheduler -->|"legion.cycle.TICKER"| orchestrator
    trigger -->|"legion.cycle.TICKER"| orchestrator
    orchestrator -->|"legion.cycle.TICKER"| agents
    orchestrator -->|"legion.cycle.TICKER"| risk

    agents -->|gather| gunvest
    agents -->|generate| ollama
    agents -->|"legion.vote.TICKER.round"| emitter
    risk -->|"legion.constraint.TICKER.round"| emitter

    emitter -->|"next round + dissent<br/>(legion.cycle.TICKER)"| agents
    emitter -->|"persist round, votes, signal"| db
    emitter -->|signal| tg
    emitter -->|"legion.consensus.TICKER"| db
```

Per round the emitter waits for `expectedAgents` votes (and the risk constraint, if enabled),
scales each vote's weight by reliability `ρ` and conviction by calibration, discounts redundant
agreement in the quorum (ADR 0015), and aggregates. If the round has not converged and the round
cap is not reached, it republishes the cycle for the next round **with the prior votes attached as
dissent**, so agents must confront disagreement before re-voting. A consensus reached only in a
later round must still retain independent round-1 backing or it is rejected as herding (ADR 0016).

---

## 3. Consensus round lifecycle

Up to `R_max = 3` rounds (ADR 0001). Convergence requires both a directional quorum
`κ ≥ 2/3` and dispersion `V ≤ θ_v` (0.5).

```mermaid
sequenceDiagram
    participant S as Scheduler/Trigger
    participant A as Agents (×4)
    participant R as Risk node
    participant E as Emitter
    participant DB as legion schema
    participant TG as Telegram

    S->>A: legion.cycle.TICKER (round 1)
    S->>R: legion.cycle.TICKER (round 1)

    loop each round (max 3)
        A->>A: gather data + LLM generate + parse vote
        A->>E: legion.vote.TICKER.r (×4)
        R->>E: legion.constraint.TICKER.r
        Note over E: scale weights by ρ,<br/>compute S, V, κ
        alt converged (κ≥2/3 and V≤θ_v) or round = max
            E->>DB: persist round + votes
            E->>DB: signal + forecast snapshot + entry price
            E->>TG: formatted signal
        else not converged
            E->>A: legion.cycle.TICKER (round r+1, + dissent)
        end
    end
```

If no round converges by `R_max`, the signal band is `NO_CONSENSUS` (HOLD) — an honest "we
disagree" rather than a forced trade.

---

## 4. Reliability feedback loop

Agents self-tune from outcomes via a Brier score (ADR 0008), fed by the forward paper-test
(ADR 0009). The loop spans cycles and days, not a single evaluation.

```mermaid
flowchart LR
    emit["Emitter finalizes signal"]
    snap["Snapshot per-agent forecasts<br/>+ entry prices (stock/SPY/QQQ) + resolve_after"]
    wait{"horizon elapsed?"}
    resolve["Resolver: return from captured<br/>entry → horizon close, vs SPY / QQQ"]
    outcome["outcome = return &gt; SPY<br/>(alpha)"]
    brier["Brier loop (recency-decayed, asymmetric):<br/>ρ = clamp(1 + gain·(0.25 − meanBrier), 0.5, 1.5)"]
    store[("agent_reliability.rho")]
    scale["Emitter scales weights<br/>W_i = w_i · ρ_i next cycle"]

    emit --> snap --> wait
    wait -->|no| wait
    wait -->|yes| resolve --> outcome --> brier --> store --> scale
```

`ρ` stays neutral at `1.0` until an agent has at least 5 resolved forecasts (over a trailing
window of 50), so a fresh deploy behaves like an unweighted panel until evidence accrues. Within
that window forecasts are **recency-weighted** (a ~20-forecast half-life) and the mapping is
**asymmetric** — a deteriorating forecaster loses trust faster than an improving one gains it,
because acting on a bad call costs capital (ADR 0017).

The same Brier loop also learns a **calibration** factor `cal` per agent — does an agent state
higher conviction when it turns out right than when it turns out wrong? `cal` scales the
conviction term (`c'_i = c_i · cal_i`), distinct from `ρ` which scales the prior `w_i`, so a
confident-but-uninformative voice cannot buy influence by always shouting. It is bounded to
`[0.5, 1.5]` and cold-start neutral on the same `MIN_RESOLVED`/`WINDOW` guardrails (ADR 0014).

---

## 5. Inference serialization

CPU-only Ollama on the A1 VM can run exactly one 7B inference at a time. A concurrent sweep
must not pile requests past their deadline (ADR 0005).

```mermaid
flowchart TB
    subgraph procs["Agent processes (each holds ≤1 in-flight)"]
        t["technical<br/>limiter(1)"]
        n["news<br/>limiter(1)"]
        s["social<br/>limiter(1)"]
        c["contrarian<br/>limiter(1)"]
    end

    q["Ollama queue<br/>(≤ 4 waiting)"]
    exec["OLLAMA_NUM_PARALLEL=1<br/>one inference, all cores<br/>OLLAMA_KEEP_ALIVE=-1"]

    t --> q
    n --> q
    s --> q
    c --> q
    q --> exec
```

Each request carries an `AbortController` deadline and a custom undici dispatcher
(`headersTimeout: 0`) so only *our* timeout applies; transient transport errors retry with
backoff, but a timeout is treated as genuine saturation and is **not** retried — the agent
abstains instead.

---

## 6. Deployment topology

One Compose stack per VM, joined to GunVest's Docker network so it can reach GunVest's services
by name; the web container is the only public ingress, via GunVest's Cloudflare tunnel (ADR 0004).

```mermaid
flowchart TB
    cf["Cloudflare tunnel<br/>legion.&lt;domain&gt;"]

    subgraph vm["Oracle A1 VM"]
        subgraph legionnet["legion compose stack (legion-*)"]
            web["web (ingress)"]
            api["api"]
            nats["nats"]
            ollama["ollama"]
            ag["agents ×4 + risk"]
            emitter["emitter"]
            sched["scheduler"]
            crons["reliability + summary crons"]
        end

        subgraph shared["shared gunvest network"]
            gvapi["gunvest-app"]
            gvdb[("gunvest-db<br/>(127.0.0.1 only)")]
        end
    end

    cf --> web
    web -->|LEGION_API_PROXY| api
    api --> gvdb
    ag --> gvapi
    ag --> ollama
    emitter --> gvdb
    sched --> nats
    crons --> gvdb
```

GunVest's Postgres binds only to loopback, so the host gateway cannot reach it — joining the
shared network (not `host.docker.internal`) is what lets Legion talk to `gunvest-db`.

---

## 7. Data model (`legion` schema)

A single idempotent `src/db/schema.sql` owns these tables (ADR 0013).

```mermaid
erDiagram
    tickers ||--o{ cycles : has
    cycles ||--o{ rounds : contains
    rounds ||--o{ votes : records
    cycles ||--o{ signals : emits
    signals ||--o{ signal_votes : snapshots
    agent_reliability ||..|| signal_votes : "scores (by agent_id)"

    tickers {
        text symbol PK
        bool enabled
    }
    cycles {
        bigint id PK
        text symbol FK
        text status
    }
    rounds {
        bigint id PK
        bigint cycle_id FK
        int round_no
        numeric s_score
        numeric dispersion
        numeric quorum
        bool converged
    }
    votes {
        bigint id PK
        bigint round_id FK
        text agent_id
        int stance
        numeric conviction
        numeric weight
        text rationale
    }
    signals {
        bigint id PK
        bigint cycle_id FK
        text symbol
        text band
        numeric conviction
        jsonb plan
        double entry_price
        double spy_entry_price
        double qqq_entry_price
        int horizon_days
        timestamptz resolve_after
        bool resolved
        double forward_return
        double spy_return
        int outcome
    }
    signal_votes {
        bigint signal_id FK
        text agent_id
        int stance
        double conviction
        double weight
    }
    agent_reliability {
        text agent_id PK
        double rho
        double calibration
        int sample_size
    }
    agent_correlation {
        text agent_a PK
        text agent_b PK
        double corr
        int sample_size
    }
    backtest_results {
        bigint id PK
        text symbol
        int trades
        int hits
        double hit_rate
        double pnl
        double spy_pnl
        double qqq_pnl
    }
    agent_config {
        text agent_id PK
        text provider
        text model
        bool enabled
    }
```

`signal_votes` is a denormalized forecast snapshot taken at emit time; the resolver fills the
resolution columns on `signals` after the horizon, and the Brier loop reads the join to update
`agent_reliability`. `agent_config` is read per cycle to pick each agent's LLM provider.

---

## Architecture Decision Records

Each ADR is a short, dated record of one decision: its context, the choice, the alternatives
weighed, and the consequences. They live in [`docs/adr/`](adr/).

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-consensus-protocol.md) | BFT-flavored leaderless consensus |
| [0002](adr/0002-message-bus.md) | NATS message bus with in-memory test double |
| [0003](adr/0003-inference-abstraction.md) | Pluggable LLM provider abstraction |
| [0004](adr/0004-deployment.md) | Single-VM Docker deployment on Oracle A1 |
| [0005](adr/0005-ollama-serial-inference.md) | Serialize Ollama inference under concurrent load |
| [0006](adr/0006-gunvest-client-resilience.md) | Resilient GunVest data client |
| [0007](adr/0007-gunvest-data-source.md) | GunVest as the sole data source and datastore |
| [0008](adr/0008-reliability-weighting.md) | Reliability-weighted consensus (Brier → ρ) |
| [0009](adr/0009-self-evaluation.md) | Forward paper-test + deterministic backtest |
| [0010](adr/0010-vote-contract-parsing.md) | Vote contract and tolerant parsing |
| [0011](adr/0011-risk-manager-constraint.md) | Risk Manager as a deterministic, non-voting constraint |
| [0012](adr/0012-dashboard-read-write-split.md) | Dashboard: thin read API + separate SPA + trigger |
| [0013](adr/0013-schema-management.md) | Single idempotent `schema.sql` (no migration tool) |
| [0014](adr/0014-conviction-calibration.md) | Conviction calibration (cal scales c_i, distinct from ρ) |
| [0015](adr/0015-correlated-agent-quorum.md) | Redundancy-discounted quorum (correlated agents count less) |
| [0016](adr/0016-anti-herding-guard.md) | Anti-herding guard (revision consensus needs independent backing) |
| [0017](adr/0017-reliability-recency-asymmetry.md) | Recency-decayed, asymmetric reliability (refines 0008) |
