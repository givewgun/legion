# Running the Legion stack locally

End-to-end guide to bring up the full gestalt on one machine: infra → data → migrate →
seed → run the agents → see a signal. For the design see
[`superpowers/specs/2026-06-04-legion-design.md`](superpowers/specs/2026-06-04-legion-design.md).

---

## 1. What the stack is made of

Legion is a set of **independent Node processes** that talk over a NATS message bus. They
read market data from GunVest's REST API and persist debate state to a shared Postgres.

| Component                        | Provided by                  | Default address                                       | Required?                            |
| -------------------------------- | ---------------------------- | ----------------------------------------------------- | ------------------------------------ |
| **NATS** message bus             | `docker compose` (this repo) | `nats://localhost:4222`                               | yes                                  |
| **Ollama** local LLM             | `docker compose` (this repo) | `http://localhost:11434`                              | yes (agents vote via it)             |
| **PostgreSQL** (`legion` schema) | GunVest (shared instance)    | `postgres://postgres:postgres@localhost:5432/gunvest` | yes (emitter/orchestrator/scheduler) |
| **GunVest REST API**             | GunVest repo (separate)      | `http://localhost:3001`                               | yes for live data¹                   |
| **Telegram bot**                 | GunVest's bot token          | —                                                     | optional (signal delivery)           |
| **Finnhub**                      | finnhub.io free key          | —                                                     | optional (short-interest feed only)  |

¹ Without GunVest the agents still run, but every `gather()` fails → each agent **abstains**
(HOLD/0) and signals are meaningless. The Contrarian's net-new feeds (CNN put/call, AAII,
NAAIM, Finnhub) fetch **directly** and work without GunVest; its F&G + VIX inputs come via
GunVest.

GunVest endpoints Legion consumes: `GET /api/market/:ticker` (technical — per-ticker quote +
~1y daily history; entry-price & risk also use it), `GET /api/news/:ticker` (news — trimmed and
relevance-ranked client-side before voting), `GET /api/sentiment/:ticker` (social, contrarian),
`GET /api/sentiment/stock/fear-greed` and `GET /api/macro` (contrarian, news, risk).

**Legion processes** (one role per process): `emitter`, `agent:technical`, `agent:news`,
`agent:social`, `agent:contrarian`, `risk`, plus `scheduler` (cron) or `kick` (one-shot).

---

## 2. Prerequisites

- Node.js ≥ 18, npm
- Docker + Docker Compose
- A running **GunVest** instance (its REST API on `:3001` and its PostgreSQL on `:5432`).
  See the GunVest repo. Legion shares that Postgres and isolates itself in the `legion` schema.

---

## 3. One-time setup

```bash
npm install
cp .env.example .env          # then edit (see §6)

# Start infra only (message bus + local LLM). Postgres comes from GunVest.
docker compose up -d nats ollama

# Pull the model the agents use (first time only; a few GB)
docker exec -it legion-ollama ollama pull qwen3:1.7b

# Create the legion schema in GunVest's Postgres
npm run db:migrate            # prints "legion schema migrated"

# Seed at least one ticker (cycles FK to legion.tickers)
psql "postgres://postgres:postgres@localhost:5432/gunvest" -c \
  "INSERT INTO legion.tickers (symbol, enabled) VALUES ('NVDA', true) \
   ON CONFLICT (symbol) DO UPDATE SET enabled = true;"
```

> Verify infra: `docker ps` shows `legion-nats` (4222) and `legion-ollama` (11434);
> `curl localhost:3001/api/macro` returns GunVest macro JSON.

---

## 4. Run it — recommended (infra in Docker, app on host)

App processes run on the host with the `.env` localhost defaults. Use **7 terminals** (or a
multiplexer). Order doesn't matter much — agents/emitter just wait for messages — but start
the emitter first so it catches round 1.

```bash
npm run emitter            # waits for 4 votes + the risk constraint, runs consensus, emits
npm run agent:technical
npm run agent:news
npm run agent:social
npm run agent:contrarian   # pulls the live crowd-positioning panel
npm run risk               # non-voting deterministic constraint node
```

Then kick a cycle:

```bash
npm run kick NVDA          # one-shot: evaluate NVDA now
# or drive every enabled ticker on the schedule:
npm run scheduler -- --now # runs the cron loop AND fires one sweep immediately
```

Or trigger over HTTP without shell access on the box — the `api` service exposes it (needs
the NATS bus connected; returns `503` otherwise). Useful to re-run after a fix instead of
waiting for the next scheduled sweep:

```bash
curl -X POST localhost:8088/api/trigger/NVDA   # kick one ticker  -> 202 {symbol, cycleId}
curl -X POST localhost:8088/api/trigger        # sweep all enabled -> 202 {kicked: [...]}
```

The reliability learning pass (resolve due signals + recompute the dials) can likewise be
re-run on demand instead of waiting for its cron — also exposed as the **Run all cycles**
and **Relearn reliability** buttons on the dashboard's Config page (login-gated):

```bash
curl -X POST localhost:8088/api/reliability/relearn  # -> 200 {resolved, correlations, agents}
```

A converged signal (or `NO_CONSENSUS`) is sent to Telegram (if configured) and every round
is written to `legion.rounds` / `legion.votes`.

A cycle is **4 agents × up to 3 rounds**, serialized through one Ollama → expect minutes,
not seconds, on CPU. Inference is serial by server config (`OLLAMA_NUM_PARALLEL=1`) so
each request gets all CPU cores; the model stays resident for the whole sweep
(`OLLAMA_KEEP_ALIVE=30m`, refreshed on every call) to avoid a ~5 GB reload between calls,
then unloads between cycles so runner memory can't accumulate.

---

## 5. Run it — all-in-Docker (advanced)

`docker compose up -d` also starts `emitter`, `agent-*`, `risk`, `scheduler` containers (built
from the `Dockerfile`). Inside the compose network, `localhost` does **not** reach the host or
sibling containers, so override these in `.env` before `up`:

```ini
NATS_URL=nats://nats:4222
OLLAMA_URL=http://ollama:11434
# Postgres + GunVest run on the host (or in GunVest's own compose):
DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/gunvest
GUNVEST_API_URL=http://host.docker.internal:3001
```

```bash
docker compose up -d              # infra + all legion services
docker compose run --rm emitter npm run db:migrate   # once
docker compose logs -f emitter agent-technical
```

The scheduler container fires on `LEGION_CRON` (default twice per US trading day); for an immediate sweep use
the host one-shot `npm run kick NVDA` against the same NATS.

---

## 6. Configuration (`.env`)

| Var                                                            | Default                                               | Notes                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GUNVEST_API_URL`                                              | `http://localhost:3001`                               | GunVest REST base                                                                                                                         |
| `DATABASE_URL`                                                 | `postgres://postgres:postgres@localhost:5432/gunvest` | shared Postgres; `legion` schema                                                                                                          |
| `NATS_URL`                                                     | `nats://localhost:4222`                               | message bus                                                                                                                               |
| `OLLAMA_URL` / `OLLAMA_MODEL`                                  | `http://localhost:11434` / `qwen3:1.7b`      | local LLM                                                                                                                                 |
| `OLLAMA_TIMEOUT_MS`                                            | `300000`                                              | per-request inference deadline (ms); raise on slow hardware                                                                               |
| `OLLAMA_MAX_CONCURRENT`                                        | `1`                                                   | in-flight inferences per agent process; keep at 1 to match `OLLAMA_NUM_PARALLEL=1` on the server                                          |
| `GUNVEST_TIMEOUT_MS`                                           | `15000`                                               | per-request GunVest deadline (ms); raise if a sweep bursts the slow `/api/news` endpoint into `timeout after Nms` abstains               |
| `GUNVEST_RETRIES`                                             | `2`                                                   | retries on transient transport errors / 429 / 5xx (initial + N)                                                                          |
| `GUNVEST_MAX_CONCURRENT`                                      | `6`                                                   | in-flight GunVest requests per agent process; lower to ease load on the single-threaded API during sweeps                                |
| `GUNVEST_MACRO_TTL_MS`                                        | `60000`                                               | dedupe window for the global `/api/macro` snapshot so a sweep fetches it once, not once-per-ticker; `0` disables                         |
| `LEGION_EXPECTED_AGENTS`                                       | `4`                                                   | votes the emitter waits for per round                                                                                                     |
| `LEGION_EMITTER_STALE_MS`                                     | `5400000`                                             | silence after which the emitter evicts an incomplete `(cycle, round)` vote buffer and times out its cycle; bounds memory if an agent never votes or a constraint never arrives |
| `LEGION_RISK_ENABLED`                                          | `true`                                                | also wait for the risk constraint before finalizing                                                                                       |
| `LEGION_CRON` / `LEGION_CRON_TZ`                               | `0 11,17 * * 1-5` / `America/New_York`                | scheduler cadence: mid-session + post-close in exchange time, US trading days only ([ADR 0029](adr/0029-market-aware-cron.md))            |
| `CONSENSUS_THETA_V` / `_QUORUM` / `_MAX_ROUNDS` / `_HOLD_BAND` | `0.5` / `0.6667` / `3` / `0.5`                        | consensus tuning                                                                                                                          |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`                      | —                                                     | signal delivery (optional)                                                                                                                |
| `FINNHUB_API_KEY`                                              | —                                                     | enables the Contrarian short-interest feed only; copy from GunVest. The other feeds (F&G, VIX, put/call, AAII, NAAIM) are live without it |

---

## 7. Verify it worked

```bash
# Rounds + the final signal for the latest cycles
psql "$DATABASE_URL" -c \
  "SELECT round_no, s_score, dispersion, quorum, converged FROM legion.rounds ORDER BY id DESC LIMIT 5;"
psql "$DATABASE_URL" -c \
  "SELECT symbol, band, conviction, created_at FROM legion.signals ORDER BY id DESC LIMIT 3;"
```

Smoke-test the Contrarian feeds in isolation (real network, no infra needed):

```bash
node -e "import('./src/data/feeds/cboe.js').then(async m=>console.log('put/call', await m.fetchPutCall({})))"
node -e "import('./src/data/feeds/aaii.js').then(async m=>console.log('aaii', await m.fetchAaii({})))"
node -e "import('./src/data/feeds/naaim.js').then(async m=>console.log('naaim', await m.fetchNaaim({})))"
```

Run the test suite (infra-free): `npm test`.

---

## 8. Troubleshooting

| Symptom                                                   | Cause / fix                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `insert or update on table "cycles" violates foreign key` | Ticker not seeded — run the `INSERT INTO legion.tickers` from §3.                                                                                                        |
| Vote rationale `abstain (data fetch failed: …)`           | A GunVest endpoint was unreachable or 404'd. Technical needs per-ticker `GET /api/market/:ticker` (quote + ~1y history; Finnhub fallback). Confirm `curl localhost:3001/api/market/NVDA` and `curl localhost:3001/api/macro`. |
| Vote rationale `abstain (data fetch failed: Ollama request timed out after …ms)` | The LLM call (not GunVest) hit its deadline. On the CPU-only Oracle tier this used to be endemic: calls queued behind the single `OLLAMA_NUM_PARALLEL` slot were killed at undici's default 300s headers timeout no matter how high `OLLAMA_TIMEOUT_MS` was set. Fixed — the provider now stretches the HTTP timeouts to the configured deadline, so queued calls genuinely wait their turn. If it still fires, the box truly took >`OLLAMA_TIMEOUT_MS` (or `HOME_TIMEOUT_MS` for the PC tier): use a smaller `OLLAMA_MODEL` or raise the knob. |
| Vote rationale `abstain (unparseable vote)`               | The local model returned no parseable JSON (too small / overloaded). Retry, or use a stronger `OLLAMA_MODEL`. The news feed is now trimmed + relevance-ranked to reduce this. |
| Emitter never emits                                       | Fewer than `LEGION_EXPECTED_AGENTS` agents running, or `LEGION_RISK_ENABLED=true` but the `risk` process is down (emitter waits for the constraint). Start all 5 + risk. |
| `ECONNREFUSED 4222`                                       | NATS not up — `docker compose up -d nats`.                                                                                                                               |
| Ollama timeouts / `model not found`                       | `docker exec -it legion-ollama ollama pull qwen3:1.7b`; first inference is slow on CPU. If timeouts persist under load, confirm `OLLAMA_NUM_PARALLEL=1` is set on the container (prevents CPU saturation from concurrent requests) and raise `OLLAMA_TIMEOUT_MS` if needed.                              |
| Short-interest feed always `null`                         | `FINNHUB_API_KEY` unset (expected — only that feed needs it).                                                                                                            |
| AAII / NAAIM feed `null`                                  | HTML scrape of aaii.com / ycharts.com; layout-fragile and degrades to `null` on any change. Other feeds are unaffected.                                                  |
| Docker agents can't reach DB/NATS                         | Using `localhost` inside containers — apply the §5 `nats`/`ollama`/`host.docker.internal` overrides.                                                                     |
