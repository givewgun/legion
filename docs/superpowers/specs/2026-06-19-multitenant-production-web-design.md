# Multi-Tenant Production Web Layer — Design

**Date:** 2026-06-19
**Status:** Approved (brainstorming) — ready for implementation planning
**Branch:** `claude/multitenant-production-web`

## Problem

The dashboard (`legion-web`) is served in production by `vite preview` — a dev/preview
server, not a production static server. It is single-threaded, does no compression or
cache-control, and proxies `/api` through Vite's dev proxy. The app is also wide open: no
authentication, no concept of a user. The goal is to make the web layer **production-grade**
and **multi-tenant**, so multiple authenticated users each get their own watchlist and
simulated portfolio on top of the shared research engine.

## Constraints

- **≈$0 runtime** (ADR 0004). One Oracle A1 free-tier VM (now 12 GB), shared with GunVest.
- **The LLM debate engine stays shared.** Running the agent debate per-user is infeasible —
  serial Ollama already takes tens of minutes per sweep (ADR 0005). Signals, debates,
  reliability are global, published research that every user sees.
- **CI/CD fully automated.** No manual VM step. nginx must build and deploy through the
  existing `.github/workflows/ci.yml` pipeline.
- Already behind a Cloudflare tunnel; TLS terminates at the edge.

## Scope

**Per-user (new):**
- Watchlist — each user follows a subset of the global ticker roster; dashboard filtered.
- Simulated portfolio — each user's paper account (starting cash, horizon) over the shared
  signals, filtered to their watchlist.

**Shared/global (unchanged):** ticker roster, cycles, debates, signals, reliability, agents.
The engine and its tables are untouched — zero migration risk to the pipeline.

**Auth:** self-managed Google OAuth (authorization-code flow) in the existing `api` service.
**Gating:** whole app requires login. **Signup:** email allowlist (friends/family scale).

## Architecture

```
Browser → Cloudflare tunnel → nginx (web) ─ static SPA bundle
                                          └ /api/* → api:8088 (Express + OAuth + sessions)
                                                       └ Postgres (gunvest VM, legion schema)
```

One backend: OAuth callbacks and sessions live in the **existing `api` Express service**, not
a separate BFF — avoids a second container on a tight VM. nginx is the sole tunnel ingress.

### Section 1 — Production serving + request topology

Replace `vite preview` with nginx serving the built bundle and reverse-proxying `/api`.

- `web/Dockerfile` becomes multi-stage: a `node` build stage runs `vite build`; the output is
  copied into `nginx:alpine`.
- nginx serves the static SPA: gzip, cache-control (immutable for hashed assets, no-cache for
  `index.html`), and `try_files $uri /index.html` SPA fallback.
- nginx reverse-proxies `/api/*` → `api:8088`. TLS terminates at the Cloudflare edge; nginx
  stays plain HTTP inside the `legion` / `tunnel-gateway` networks.
- `docker-compose.prod.yml` `web` service: drop `command:` and `LEGION_API_PROXY`; it just
  runs nginx. **nginx listens on 5174** (`listen 5174;` in the nginx config) so the existing
  `expose: 5174` and the Cloudflare tunnel ingress mapping stay unchanged. Still on
  `[legion, tunnel-gateway]`.
- `web/vite.config.js` keeps its `/api` proxy for **local dev only** (`vite` / `npm run dev`);
  it is no longer used in prod.

**Why nginx over Caddy:** behind the tunnel there is no need for Caddy's auto-HTTPS; nginx is
lighter on the shared VM and is the standard static+proxy. **Rejected:** a Node static server
(`serve` / Express static) — heavier per connection and reinvents nginx's caching/compression.

### Section 2 — Auth flow (Google OAuth, in `api`)

Server-side OAuth2 authorization-code flow in Express:

- `GET /api/auth/google` → redirect to Google consent with `state` + `nonce`.
- `GET /api/auth/google/callback` → exchange code, verify Google ID token, check the email
  allowlist, upsert `legion.users` by `google_sub`, create a server-side session, set the
  session cookie, redirect to the SPA. Non-allowlisted email → `403` + "not authorized"
  (no session, no user row).
- `POST /api/auth/logout` → destroy session, clear cookie.
- `GET /api/auth/me` → current user or `401`. The SPA calls this on load to choose login vs app.

**Sessions:** server-side in Postgres (revocable). `express-session` + `connect-pg-simple`,
session table in the `legion` schema. Cookie is **httpOnly, Secure, SameSite=Lax**.

**ID-token verification:** official `google-auth-library`. Tests mock the verifier — no live
Google call in CI.

**CSRF:** SameSite=Lax + the OAuth `state` param covers the login flow. State-changing
per-user routes (watchlist edits) additionally require an `X-Requested-With` header check —
cheap, no token plumbing at this scale.

**Middleware:** global `requireUser` on all `/api/*` except `/api/auth/*` and `/health`. It
reads `req.session.userId`, loads the user, sets `req.user`, else `401`.

### Section 3 — Data model (new tables, `legion` schema)

```sql
legion.users (
  id           BIGSERIAL PRIMARY KEY,
  google_sub   TEXT UNIQUE NOT NULL,
  email        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- connect-pg-simple session store
legion.user_session (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_session_expire ON legion.user_session (expire);

legion.user_watchlist (
  user_id  BIGINT NOT NULL REFERENCES legion.users(id) ON DELETE CASCADE,
  symbol   TEXT NOT NULL REFERENCES legion.tickers(symbol),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

legion.user_portfolio_config (
  user_id       BIGINT PRIMARY KEY REFERENCES legion.users(id) ON DELETE CASCADE,
  starting_cash NUMERIC(14,2) NOT NULL DEFAULT 100000,
  horizon_days  INTEGER NOT NULL DEFAULT 5,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

All shared tables untouched. The simulated portfolio stays **deterministic** — no stored
positions or trade ledger (YAGNI). Per-user portfolio =
`simulatePortfolio(signals filtered to the user's watchlist, candles, user config)`, computed
on demand and cached per-user (keyed by a config+watchlist hash).

### Section 4 — API scoping + web UI

**API:**
- New `watchlistRoutes`: GET / PUT / DELETE the user's symbols, each validated against the
  global `tickers` roster.
- `portfolio.js` reworked to take `req.user` → their config + watchlist. The current single
  global portfolio cache becomes a small per-user LRU.

**Web:**
- Login gate: app calls `/api/auth/me`; unauthenticated → Google sign-in screen.
- User menu: avatar + logout.
- Watchlist manager: pick from the global ticker roster.
- Simulated Portfolio page reads the per-user endpoint.
- Shared research pages (debates, reliability, agents, signals) unchanged in content, but now
  behind the login wall.

### Section 5 — Gating, allowlist, secrets, CI

**Gating:** whole app requires login. nginx still serves the static bundle to everyone (the
bundle is not secret); the **data** is gated by `requireUser`.

**Allowlist:** `LEGION_ALLOWED_EMAILS` (comma-separated), checked in the OAuth callback before
session creation. **Rejected:** an allowlist table — overkill; the env var edits via redeploy,
which is automated.

**New environment variables** (GitHub Secrets → generated `.env` → ssh-action passthrough):
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `SESSION_SECRET` — signs the session cookie
- `LEGION_ALLOWED_EMAILS`
- `LEGION_PUBLIC_URL` (e.g. `https://legion.givewgun.com`) — builds the OAuth redirect URI

**CI changes** (`.github/workflows/ci.yml`):
- Add the new variables to the `tee .env` heredoc and to the ssh-action `env:` + `envs:` lists.
- Register them as repository secrets.
- The `web` Docker image already builds from `./web` in the `docker` job and is rebuilt by
  `compose up -d --build` on deploy — swapping `web/Dockerfile` to the nginx multi-stage build
  is picked up automatically. **No manual VM step.**

**One unavoidable out-of-repo step (one-time, not a deploy step):** register the OAuth client
and authorized redirect URI (`${LEGION_PUBLIC_URL}/api/auth/google/callback`) in the Google
Cloud Console, and copy the client id/secret into GitHub Secrets.

**Testing:**
- OAuth callback tested with a mocked Google token verifier (no live Google).
- `requireUser` and the allowlist check unit-tested.
- Watchlist + per-user portfolio routes tested in-process via `createApp` with a fake session
  (existing test pattern).
- nginx config smoke test (SPA fallback + `/api` proxy) — lightweight, optional.

## Implementation phasing

Independently shippable:

- **Phase A — Production nginx serving.** Multi-stage `web/Dockerfile`, nginx config, compose +
  vite-config edits. No behavior change, no auth. Ships value alone.
- **Phase B — Auth + multi-tenant.** Google OAuth, sessions, `requireUser`/allowlist, new
  tables, watchlist + per-user portfolio API, web login/watchlist UI, CI secret wiring.

## Out of scope (YAGNI)

- Per-user signal streams / per-user agent pipelines (infeasible on the infra).
- Stored portfolio positions or a trade ledger (sim is deterministic from config).
- Password auth, password reset, account management UI (Google OAuth + allowlist only).
- A separate auth/BFF service.
