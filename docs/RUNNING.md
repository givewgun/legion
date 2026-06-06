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
docker exec -it legion-ollama ollama pull qwen2.5:7b-instruct

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

A converged signal (or `NO_CONSENSUS`) is sent to Telegram (if configured) and every round
is written to `legion.rounds` / `legion.votes`.

A cycle is **4 agents × up to 3 rounds**, serialized through one Ollama → expect minutes,
not seconds, on CPU.

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

The scheduler container fires on `LEGION_CRON` (default every 4h); for an immediate sweep use
the host one-shot `npm run kick NVDA` against the same NATS.

---

## 6. Configuration (`.env`)

| Var                                                            | Default                                               | Notes                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GUNVEST_API_URL`                                              | `http://localhost:3001`                               | GunVest REST base                                                                                                                         |
| `DATABASE_URL`                                                 | `postgres://postgres:postgres@localhost:5432/gunvest` | shared Postgres; `legion` schema                                                                                                          |
| `NATS_URL`                                                     | `nats://localhost:4222`                               | message bus                                                                                                                               |
| `OLLAMA_URL` / `OLLAMA_MODEL`                                  | `http://localhost:11434` / `qwen2.5:7b-instruct`      | local LLM                                                                                                                                 |
| `LEGION_EXPECTED_AGENTS`                                       | `4`                                                   | votes the emitter waits for per round                                                                                                     |
| `LEGION_RISK_ENABLED`                                          | `true`                                                | also wait for the risk constraint before finalizing                                                                                       |
| `LEGION_CRON`                                                  | `0 */4 * * *`                                         | scheduler cadence (every 4h)                                                                                                              |
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
| Vote rationale `abstain (unparseable vote)`               | The local model returned no parseable JSON (too small / overloaded). Retry, or use a stronger `OLLAMA_MODEL`. The news feed is now trimmed + relevance-ranked to reduce this. |
| Emitter never emits                                       | Fewer than `LEGION_EXPECTED_AGENTS` agents running, or `LEGION_RISK_ENABLED=true` but the `risk` process is down (emitter waits for the constraint). Start all 5 + risk. |
| `ECONNREFUSED 4222`                                       | NATS not up — `docker compose up -d nats`.                                                                                                                               |
| Ollama timeouts / `model not found`                       | `docker exec -it legion-ollama ollama pull qwen2.5:7b-instruct`; first inference is slow on CPU.                                                                         |
| Short-interest feed always `null`                         | `FINNHUB_API_KEY` unset (expected — only that feed needs it).                                                                                                            |
| AAII / NAAIM feed `null`                                  | HTML scrape of aaii.com / ycharts.com; layout-fragile and degrades to `null` on any change. Other feeds are unaffected.                                                  |
| Docker agents can't reach DB/NATS                         | Using `localhost` inside containers — apply the §5 `nats`/`ollama`/`host.docker.internal` overrides.                                                                     |
