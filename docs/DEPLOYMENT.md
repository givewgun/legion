# Legion CI/CD & Deployment

One GitHub Actions workflow drives Legion, with a manual deploy step chained on the end:

```
verify ─┐
        ├─> docker ─> deploy   (deploy: manual trigger only, for now)
web ────┘
```

| Job      | Runs on                         | What it does                                                              |
| -------- | ------------------------------- | ------------------------------------------------------------------------ |
| `verify` | push/PR to `main`, manual       | `npm ci` → lint → `db:migrate` (validates `schema.sql`) → `npm test`      |
| `web`    | push/PR to `main`, manual       | `web/`: `npm ci` → `vite build` → `vitest`                                |
| `docker` | `main` push or manual           | builds `legion:latest` (backend) + `legion-web:latest` (dashboard)       |
| `deploy` | **manual only** (`workflow_dispatch`) | SSH to the Oracle VM, pull, regen `.env`, compose up               |

Deploy does not run on push. Ship from **Actions → Legion CI → Run workflow** once
the chain is green. To switch to auto-deploy on every green `main` push, add
`|| github.ref == 'refs/heads/main'` to the `deploy` job's `if:` (marked in `ci.yml`).

---

## Deploy (`docker-compose.prod.yml`)

A self-contained copy of the base compose plus the cross-stack networking legion
needs on the shared VM. Bootstraps on first run (clones to `/opt/legion/app`), then:

1. `git fetch origin main` + `git reset --hard origin/main`
2. Detects gunvest's docker network from the running `gunvest-db` container → `GUNVEST_NETWORK`
3. Regenerates `.env` from GitHub Secrets
4. `docker compose -f docker-compose.prod.yml --env-file .env up -d --build`
   (infra first, then a one-time Ollama model pull, then `db:migrate`, then all services)
5. `docker system prune -f`

### Services & networking

| Network          | Scope                          | Members / purpose                                              |
| ---------------- | ------------------------------ | ------------------------------------------------------------- |
| `legion`         | internal                       | all legion containers resolve by service name (nats, ollama, api↔web, agents) |
| `gunvest`        | external (gunvest's `default`) | `emitter`/agents/`risk`/`scheduler`/`api` reach `gunvest-db:5432` + `gunvest-app:3001` |
| `tunnel-gateway` | external (shared)              | `web` only — the dashboard's cloudflared ingress              |

Request flow: **cloudflared → `web:5174` (vite preview) → proxies `/api` → `api:8088` → gunvest's Postgres.**
`web` is the only container with ingress; `api` has no host port. `DATABASE_URL`
uses `@gunvest-db:5432` and `GUNVEST_API_URL` is `http://gunvest-app:3001`, both
resolved over the shared `gunvest` network (no host port publishing needed).

The web container forwards `/api` via `LEGION_API_PROXY=http://api:8088` (vite's
`preview` proxy — set in `vite.config.js`).

### Cloudflare tunnel ingress

gunvest's gateway/cloudflared owns the tunnel. Add an ingress rule there pointing
your dashboard hostname at the legion web container over the shared network, e.g.:

```yaml
- hostname: legion.<your-domain>
  service: http://legion-web:5174
```

(`legion-web` resolves on `tunnel-gateway`; cloudflared must be on that network too.)

### Required GitHub Secrets

| Secret                                    | Required | Notes                                                                    |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `ORACLE_VM_HOST`                          | yes      | VM public IP (same VM as gunvest)                                        |
| `ORACLE_VM_SSH_KEY`                       | yes      | SSH private key contents                                                 |
| `DATABASE_URL`                            | yes      | `postgres://<user>:<pass>@gunvest-db:5432/gunvest` (gunvest DB creds, `legion` schema) |
| `FINNHUB_API_KEY`                         | no       | Contrarian short-interest feed only                                     |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no       | Signal delivery                                                          |

`GITHUB_TOKEN` (auto-provided) clones/pulls the private repo on the VM.

### Ollama serial inference (CPU)

The `ollama` service in `docker-compose.prod.yml` is configured for **strictly serial
inference** on a 4-core CPU box:

| Server env var | Value | Effect |
|---|---|---|
| `OLLAMA_NUM_PARALLEL` | `1` | one inference at a time — every request gets all cores |
| `OLLAMA_KEEP_ALIVE` | `30m` | model stays resident for a whole sweep (timer resets per call); unloads between cycles so runner memory is reclaimed (ADR 0005 amendment) |

These are set directly on the `ollama` container in the compose file (not in the app
`.env`). The app-side timeout and concurrency (`OLLAMA_TIMEOUT_MS=300000`,
`OLLAMA_MAX_CONCURRENT=1`) are written to `.env` by the deploy script and mirror the
same constraint on the client side.

Design rationale: [`docs/superpowers/specs/2026-06-06-ollama-serial-inference-design.md`](superpowers/specs/2026-06-06-ollama-serial-inference-design.md).

### First-time VM prep

The VM already has Docker, the running gunvest stack, and the `tunnel-gateway`
network from the gunvest deploy. No new host ports needed. Add the secrets above,
add the cloudflared ingress rule, and run the deploy. The first run pulls the
Ollama model (multi-GB).

## Dashboard auth (Google OAuth)

The dashboard requires Google sign-in (email allowlist). One-time setup, outside
the repo:

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID
   (type: Web application).
2. Authorized redirect URI: `https://legion.givewgun.com/api/auth/google/callback`
   (must match `${LEGION_PUBLIC_URL}/api/auth/google/callback`).
3. Copy the client id/secret into GitHub repo secrets:
   - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
   - `SESSION_SECRET` — a long random string (`openssl rand -hex 32`)
   - `LEGION_ALLOWED_EMAILS` — comma-separated allowed Google emails
   - `LEGION_PUBLIC_URL` — `https://legion.givewgun.com`

The deploy workflow writes these into `.env`; no manual VM step. Adding/removing
an allowed user = edit `LEGION_ALLOWED_EMAILS` and re-run the deploy.
