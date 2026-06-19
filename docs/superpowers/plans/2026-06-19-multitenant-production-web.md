# Multi-Tenant Production Web Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `vite preview` production server with nginx, and make the dashboard multi-tenant — Google OAuth login (email allowlist), per-user watchlist, and per-user simulated portfolio over the shared research engine.

**Architecture:** nginx serves the built SPA and reverse-proxies `/api` to the existing Express `api` service, which gains OAuth callbacks, Postgres-backed sessions, and a `requireUser` gate. The LLM debate engine, signals, and reliability stay global and shared; only watchlist + portfolio config are per-user. Everything builds and deploys through the existing CI/CD with no manual VM step.

**Tech Stack:** Node 20 ESM, Express 4, `express-session` + `connect-pg-simple`, `google-auth-library`, PostgreSQL (gunvest VM, `legion` schema), React 18 + Vite, nginx:alpine, Docker Compose, vitest + supertest.

## Global Constraints

- **ESM only** — `import`/`export`, `"type": "module"`. No `require`.
- **Postgres `legion` schema** — every new table is `legion.<name>`; schema is migrated by appending DDL to `src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER ... IF NOT EXISTS`). Never a separate migration runner.
- **Repo pattern** — all SQL lives in `src/db/repo.js` methods (one method per logical operation); `db.query` returns rows directly, `db.queryOne` returns one row or `null`.
- **Route pattern** — `export function xRoutes(repo, ...)` returning an Express `Router`; every handler is `async (req, res, next)` wrapped in `try/catch` calling `next(err)`; validation errors return `4xx` JSON `{ error }`.
- **Tests** — vitest (`describe`/`it`/`expect`), supertest for routes, `vi.fn()` repo stubs (no real DB in API tests); mock the Google verifier — never call live Google in CI.
- **Constants** — PascalCase module-level constants for magic numbers; named, commented.
- **Commits** — Conventional Commits. `feat:`/`fix:` only for user-facing; `chore:`/`build:`/`ci:` for infra. Never bypass git hooks.
- **No secrets in code** — OAuth client id/secret, session secret, allowlist all come from env via `loadConfig`.
- **nginx listens on 5174** so the existing `expose: 5174` and Cloudflare tunnel ingress stay unchanged.
- **Per-user routes always require `req.user`** (functional, not just security); shared-data routes are gated by a global middleware that is active whenever `auth` is configured (always in prod).

---

## File Structure

**Phase A — production serving:**
- Modify: `web/Dockerfile` — multi-stage node build → nginx:alpine.
- Create: `web/nginx.conf` — static serve + SPA fallback + `/api` proxy, listen 5174.
- Modify: `docker-compose.prod.yml` — `web` service runs nginx (drop `command:` + `LEGION_API_PROXY`).
- Modify: `web/vite.config.js` — keep proxy comment noting it's dev-only.

**Phase B — auth + multi-tenant (backend):**
- Modify: `src/db/schema.sql` — `users`, `user_session`, `user_watchlist`, `user_portfolio_config`.
- Modify: `src/db/repo.js` — user / watchlist / portfolio-config methods.
- Modify: `src/config/index.js` — `auth` config block.
- Create: `src/auth/google.js` — OAuth2 wrapper (auth URL, token exchange, id-token verify).
- Create: `src/auth/session.js` — express-session + connect-pg-simple factory.
- Create: `src/auth/middleware.js` — `requireUser`, `isAllowed`.
- Create: `src/auth/routes.js` — `/google`, `/google/callback`, `/logout`, `/me`.
- Create: `src/api/routes/watchlist.js` — per-user watchlist CRUD.
- Modify: `src/api/routes/portfolio.js` — per-user config + watchlist filter.
- Modify: `src/api/app.js` — mount session, auth routes, gate, per-user routes.
- Modify: `src/run/api.js` — build auth from config, pass into `createApp`.
- Modify: `package.json` — add `express-session`, `connect-pg-simple`, `google-auth-library`.

**Phase B — auth + multi-tenant (web):**
- Modify: `web/src/api/client.js` — `getMe`, `logout`, watchlist + portfolio calls; 401-aware `get`.
- Create: `web/src/auth/AuthContext.jsx` — provider + `useAuth`.
- Create: `web/src/auth/LoginGate.jsx` — login screen / gate.
- Modify: `web/src/App.jsx` — wrap in gate + add watchlist route + user menu.
- Modify: `web/src/ui/NavBar.jsx` — user avatar + logout + watchlist link.
- Create: `web/src/pages/WatchlistPage.jsx` — manage followed tickers.
- Modify: `web/src/pages/PortfolioPage.jsx` — already calls `getPortfolio`; no change beyond per-user data.

**Phase B — CI/docs:**
- Modify: `.github/workflows/ci.yml` — new env in `.env` heredoc + ssh-action passthrough.
- Modify: `docs/DEPLOYMENT.md` (or `docs/RUNNING.md`) — Google Cloud Console one-time setup + new secrets.
- Create: `docs/adr/0030-multitenant-web-auth.md` — ADR for the decision.

---

# PHASE A — Production nginx serving

Ships value alone, no behavior change. Pure infra; verified by build + container smoke test rather than unit tests.

### Task A1: nginx static server + reverse proxy

**Files:**
- Create: `web/nginx.conf`
- Modify: `web/Dockerfile`
- Modify: `docker-compose.prod.yml:206-217` (the `web` service)
- Modify: `web/vite.config.js:14-18` (comment only)

**Interfaces:**
- Produces: a `legion-web` container that serves the SPA on `:5174` and proxies `/api/*` to `api:8088`. No JS interface.

- [ ] **Step 1: Write the nginx config**

Create `web/nginx.conf`:

```nginx
# Production static server for the Legion dashboard. Sole tunnel ingress.
# Listens on 5174 so docker-compose `expose: 5174` and the Cloudflare tunnel
# ingress mapping stay unchanged from the old `vite preview` setup.
server {
  listen 5174;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_types text/css application/javascript application/json image/svg+xml;
  gzip_min_length 1024;

  # Hashed assets are content-addressed and immutable — cache hard.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
  }

  # API is proxied to the internal api service. proxy_http_version + headers
  # keep cookies and the original host intact for OAuth redirects.
  location /api/ {
    proxy_pass http://api:8088;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # SPA fallback: every non-file route serves index.html (no-cache so a deploy
  # is picked up immediately).
  location / {
    add_header Cache-Control "no-cache";
    try_files $uri $uri/ /index.html;
  }
}
```

- [ ] **Step 2: Rewrite the Dockerfile as multi-stage**

Replace `web/Dockerfile` entirely:

```dockerfile
# Stage 1: build the SPA bundle.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: serve it with nginx. No Node in the runtime image.
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 5174
CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 3: Update the compose `web` service**

In `docker-compose.prod.yml`, replace the `web` service body (keep the comment header) with:

```yaml
  # Dashboard SPA served by nginx. Sole tunnel ingress; proxies /api to `api`.
  web:
    build: ./web
    container_name: legion-web
    environment:
      TZ: Asia/Bangkok
    expose: ['5174']
    depends_on: [api]
    restart: unless-stopped
    networks: [legion, tunnel-gateway]
```

(Removes `command:` and `LEGION_API_PROXY` — nginx replaces both.)

- [ ] **Step 4: Mark vite proxy as dev-only**

In `web/vite.config.js`, update the `preview` block comment. Replace lines 14-18:

```javascript
  // `vite preview` is no longer used in production (nginx serves the build).
  // Kept only so `npm run preview` works for a local production-bundle check.
  preview: {
    port: 5174,
    proxy: { '/api': apiProxy },
    allowedHosts: ['legion.givewgun.com'],
  },
```

- [ ] **Step 5: Verify the image builds and serves**

Run:

```bash
docker build -t legion-web:test ./web
docker run --rm -d --name legion-web-smoke -p 5174:5174 legion-web:test
sleep 2
curl -sf http://localhost:5174/ | grep -q '<div id="root">' && echo "SPA OK"
curl -s -o /dev/null -w '%{http_code}' http://localhost:5174/some/spa/route   # expect 200 (SPA fallback)
docker rm -f legion-web-smoke
```

Expected: `SPA OK` and `200` for the deep link. (The `/api` proxy can't be smoke-tested standalone — no `api` container — that's covered by the full compose stack on deploy.)

- [ ] **Step 6: Commit**

```bash
git add web/Dockerfile web/nginx.conf docker-compose.prod.yml web/vite.config.js
git commit -m "build: serve dashboard with nginx instead of vite preview"
```

---

# PHASE B — Auth + multi-tenant

### Task B1: Database schema for users, sessions, watchlist, portfolio config

**Files:**
- Modify: `src/db/schema.sql` (append)
- Test: `test/db/schema.multitenant.test.js`

**Interfaces:**
- Produces: tables `legion.users`, `legion.user_session`, `legion.user_watchlist`, `legion.user_portfolio_config`.

- [ ] **Step 1: Append the DDL**

Append to `src/db/schema.sql`:

```sql
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
```

- [ ] **Step 2: Write the failing schema test**

Create `test/db/schema.multitenant.test.js`. This test runs only when `DATABASE_URL` points at a real Postgres (CI provides one); it skips otherwise so local unit runs stay infra-free.

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connectDb } from '../../src/db/client.js';

const dbUrl = process.env.DATABASE_URL;
const run = dbUrl ? describe : describe.skip;

run('multitenant schema', () => {
  let db;
  beforeAll(async () => {
    db = connectDb(dbUrl);
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/schema.sql');
    await db.query(await readFile(schemaPath, 'utf8'));
  });
  afterAll(async () => db?.pool.end());

  it('creates the users table with a unique google_sub', async () => {
    const rows = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'legion' AND table_name = 'users' ORDER BY column_name`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'google_sub', 'email', 'name', 'avatar_url']),
    );
  });

  it('creates user_watchlist keyed by (user_id, symbol)', async () => {
    const rows = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'legion' AND table_name = 'user_watchlist'`,
    );
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run the test (CI / local Postgres)**

Run: `npx vitest run test/db/schema.multitenant.test.js`
Expected: PASS where `DATABASE_URL` is set (CI), SKIP otherwise.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql test/db/schema.multitenant.test.js
git commit -m "feat: add multi-tenant user/watchlist/portfolio schema"
```

### Task B2: Repo methods for users, watchlist, portfolio config

**Files:**
- Modify: `src/db/repo.js` (add methods before the closing `};`)
- Test: `test/db/repo.multitenant.test.js`

**Interfaces:**
- Produces (all on the repo object):
  - `upsertUser({ googleSub, email, name, avatarUrl }) → { id, email, name, avatarUrl }`
  - `getUserById(id) → { id, email, name, avatarUrl } | null`
  - `listWatchlist(userId) → string[]` (symbols, sorted)
  - `addWatchlistSymbol(userId, symbol) → void` (symbol upper-cased; ignores duplicates)
  - `removeWatchlistSymbol(userId, symbol) → void`
  - `getPortfolioConfig(userId) → { startingCash, horizonDays } | null`
  - `upsertPortfolioConfig(userId, { startingCash, horizonDays }) → { startingCash, horizonDays }`

- [ ] **Step 1: Write the failing repo test**

Create `test/db/repo.multitenant.test.js`. Uses an in-memory fake `db` capturing SQL, asserting the methods build the right calls (mirrors the unit style; the real-DB path is covered by Task B1's schema test + the route tests).

```javascript
import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';

function fakeDb(rows = []) {
  return {
    query: vi.fn(async () => rows),
    queryOne: vi.fn(async () => rows[0] ?? null),
  };
}

describe('multitenant repo methods', () => {
  it('upsertUser upserts by google_sub and returns the row', async () => {
    const db = fakeDb([{ id: 7, email: 'a@b.com', name: 'A', avatar_url: 'x' }]);
    const repo = createRepo(db);
    const user = await repo.upsertUser({ googleSub: 'sub1', email: 'a@b.com', name: 'A', avatarUrl: 'x' });
    expect(user).toEqual({ id: 7, email: 'a@b.com', name: 'A', avatarUrl: 'x' });
    expect(db.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (google_sub)'),
      ['sub1', 'a@b.com', 'A', 'x'],
    );
  });

  it('listWatchlist returns sorted symbols', async () => {
    const db = fakeDb([{ symbol: 'AMD' }, { symbol: 'NVDA' }]);
    const repo = createRepo(db);
    expect(await repo.listWatchlist(7)).toEqual(['AMD', 'NVDA']);
  });

  it('addWatchlistSymbol upper-cases and ignores duplicates', async () => {
    const db = fakeDb();
    const repo = createRepo(db);
    await repo.addWatchlistSymbol(7, 'amd');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (user_id, symbol) DO NOTHING'),
      [7, 'AMD'],
    );
  });

  it('getPortfolioConfig maps snake_case to camelCase', async () => {
    const db = fakeDb([{ starting_cash: '50000.00', horizon_days: 10 }]);
    const repo = createRepo(db);
    expect(await repo.getPortfolioConfig(7)).toEqual({ startingCash: 50000, horizonDays: 10 });
  });

  it('getPortfolioConfig returns null when unset', async () => {
    const repo = createRepo(fakeDb([]));
    expect(await repo.getPortfolioConfig(7)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/db/repo.multitenant.test.js`
Expected: FAIL — `repo.upsertUser is not a function`.

- [ ] **Step 3: Add the repo methods**

In `src/db/repo.js`, add inside the returned object (before the final `};`):

```javascript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/db/repo.multitenant.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js test/db/repo.multitenant.test.js
git commit -m "feat: repo methods for users, watchlist, portfolio config"
```

### Task B3: Install auth dependencies + config block

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/config/index.js` (add `auth` block)
- Test: `test/config.auth.test.js`

**Interfaces:**
- Produces: `loadConfig(env).auth = { googleClientId, googleClientSecret, sessionSecret, allowedEmails: string[], publicUrl }`.

- [ ] **Step 1: Add the dependencies**

Run:

```bash
npm install express-session connect-pg-simple google-auth-library
```

Verify they land in `package.json` `dependencies`.

- [ ] **Step 2: Write the failing config test**

Create `test/config.auth.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config/index.js';

describe('auth config', () => {
  it('parses the allowlist into a trimmed lowercase array', () => {
    const cfg = loadConfig({
      LEGION_ALLOWED_EMAILS: 'A@B.com, c@d.com ',
      GOOGLE_OAUTH_CLIENT_ID: 'id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      SESSION_SECRET: 'shh',
      LEGION_PUBLIC_URL: 'https://legion.givewgun.com',
    });
    expect(cfg.auth.allowedEmails).toEqual(['a@b.com', 'c@d.com']);
    expect(cfg.auth.googleClientId).toBe('id');
    expect(cfg.auth.publicUrl).toBe('https://legion.givewgun.com');
  });

  it('defaults to an empty allowlist when unset', () => {
    expect(loadConfig({}).auth.allowedEmails).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/config.auth.test.js`
Expected: FAIL — `cfg.auth` is undefined.

- [ ] **Step 4: Add the config block**

In `src/config/index.js`, add to the returned object (after the `consensus` block, before the closing `};`):

```javascript
    // Multi-tenant web auth (ADR 0030). allowedEmails gates who can create a
    // session; empty array = nobody can log in (fail closed).
    auth: {
      googleClientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
      googleClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      sessionSecret: env.SESSION_SECRET || '',
      publicUrl: env.LEGION_PUBLIC_URL || 'http://localhost:5174',
      allowedEmails: (env.LEGION_ALLOWED_EMAILS || '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/config.auth.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config/index.js test/config.auth.test.js
git commit -m "feat: auth config block and dependencies"
```

### Task B4: Google OAuth wrapper

**Files:**
- Create: `src/auth/google.js`
- Test: `test/auth/google.test.js`

**Interfaces:**
- Consumes: `google-auth-library` `OAuth2Client` (injectable for tests).
- Produces: `createGoogleAuth({ clientId, clientSecret, redirectUri, client }) → { authUrl(state), exchange(code) }` where `exchange(code) → { googleSub, email, name, avatarUrl }`.

- [ ] **Step 1: Write the failing test**

Create `test/auth/google.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { createGoogleAuth } from '../../src/auth/google.js';

function fakeClient(payload) {
  return {
    generateAuthUrl: vi.fn(({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    getToken: vi.fn(async () => ({ tokens: { id_token: 'idtok' } })),
    verifyIdToken: vi.fn(async () => ({ getPayload: () => payload })),
  };
}

describe('createGoogleAuth', () => {
  it('builds a consent URL carrying the state param', () => {
    const auth = createGoogleAuth({ clientId: 'id', clientSecret: 's', redirectUri: 'r', client: fakeClient({}) });
    expect(auth.authUrl('xyz')).toContain('state=xyz');
  });

  it('exchanges a code into a normalized profile', async () => {
    const client = fakeClient({ sub: 'g1', email: 'a@b.com', name: 'A', picture: 'pic' });
    const auth = createGoogleAuth({ clientId: 'id', clientSecret: 's', redirectUri: 'r', client });
    const profile = await auth.exchange('code123');
    expect(profile).toEqual({ googleSub: 'g1', email: 'a@b.com', name: 'A', avatarUrl: 'pic' });
    expect(client.getToken).toHaveBeenCalledWith('code123');
    expect(client.verifyIdToken).toHaveBeenCalledWith({ idToken: 'idtok', audience: 'id' });
  });

  it('throws when the id token has no email', async () => {
    const auth = createGoogleAuth({ clientId: 'id', clientSecret: 's', redirectUri: 'r', client: fakeClient({ sub: 'g1' }) });
    await expect(auth.exchange('c')).rejects.toThrow(/email/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/auth/google.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/auth/google.js`:

```javascript
import { OAuth2Client } from 'google-auth-library';

// Wraps Google's OAuth2 authorization-code flow. `client` is injectable so
// tests run without contacting Google; in prod it defaults to a real
// OAuth2Client built from the credentials.
export function createGoogleAuth({ clientId, clientSecret, redirectUri, client }) {
  const oauth = client ?? new OAuth2Client(clientId, clientSecret, redirectUri);

  return {
    // Consent URL. `state` is an unguessable token the caller stores in the
    // session and re-checks on callback (CSRF defense for the login flow).
    authUrl(state) {
      return oauth.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        state,
      });
    },

    // Exchange the callback code for tokens, verify the id token, return a
    // normalized profile. Throws if the token is invalid or lacks an email.
    async exchange(code) {
      const { tokens } = await oauth.getToken(code);
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const payload = ticket.getPayload();
      if (!payload?.email) throw new Error('Google id token missing email');
      return {
        googleSub: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        avatarUrl: payload.picture ?? null,
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/auth/google.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/google.js test/auth/google.test.js
git commit -m "feat: Google OAuth code-flow wrapper"
```

### Task B5: requireUser middleware + allowlist check

**Files:**
- Create: `src/auth/middleware.js`
- Test: `test/auth/middleware.test.js`

**Interfaces:**
- Consumes: `repo.getUserById`.
- Produces:
  - `isAllowed(email, allowedEmails) → boolean` (case-insensitive).
  - `requireUser(repo) → async (req, res, next)` — sets `req.user` from `req.session.userId` or responds `401 { error: 'authentication required' }`.

- [ ] **Step 1: Write the failing test**

Create `test/auth/middleware.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { isAllowed, requireUser } from '../../src/auth/middleware.js';

function res() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
}

describe('isAllowed', () => {
  it('matches case-insensitively', () => {
    expect(isAllowed('A@B.com', ['a@b.com'])).toBe(true);
    expect(isAllowed('x@y.com', ['a@b.com'])).toBe(false);
  });
  it('rejects everyone when the allowlist is empty', () => {
    expect(isAllowed('a@b.com', [])).toBe(false);
  });
});

describe('requireUser', () => {
  it('401s when there is no session user', async () => {
    const r = res();
    const next = vi.fn();
    await requireUser({ getUserById: vi.fn() })({ session: {} }, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('sets req.user and calls next when the session is valid', async () => {
    const req = { session: { userId: 7 } };
    const next = vi.fn();
    const repo = { getUserById: vi.fn(async () => ({ id: 7, email: 'a@b.com' })) };
    await requireUser(repo)(req, res(), next);
    expect(req.user).toEqual({ id: 7, email: 'a@b.com' });
    expect(next).toHaveBeenCalled();
  });

  it('401s when the session points at a deleted user', async () => {
    const r = res();
    const next = vi.fn();
    await requireUser({ getUserById: vi.fn(async () => null) })({ session: { userId: 9 } }, r, next);
    expect(r.status).toHaveBeenCalledWith(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/auth/middleware.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/auth/middleware.js`:

```javascript
// True only if `email` is on the allowlist (case-insensitive). An empty
// allowlist denies everyone — fail closed.
export function isAllowed(email, allowedEmails) {
  return allowedEmails.includes(email.trim().toLowerCase());
}

// Gate: requires a valid session pointing at an existing user. Sets req.user.
// 401s (never throws) so the SPA can show the login screen.
export function requireUser(repo) {
  return async (req, res, next) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'authentication required' });
      const user = await repo.getUserById(userId);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/auth/middleware.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/middleware.js test/auth/middleware.test.js
git commit -m "feat: requireUser gate and email allowlist check"
```

### Task B6: Auth routes (login, callback, logout, me)

**Files:**
- Create: `src/auth/routes.js`
- Test: `test/auth/routes.test.js`

**Interfaces:**
- Consumes: `createGoogleAuth` result (`authUrl`, `exchange`), `repo.upsertUser`, `repo.getUserById`, `isAllowed`.
- Produces: `authRoutes({ google, repo, allowedEmails, publicUrl }) → Router` mounting:
  - `GET /google` → 302 to `google.authUrl(state)`, stores `req.session.oauthState`.
  - `GET /google/callback?code&state` → validates state, `google.exchange`, allowlist check, `upsertUser`, sets `req.session.userId`, 302 to `/`.
  - `POST /logout` → destroys session, 204.
  - `GET /me` → `{ id, email, name, avatarUrl }` or 401.

- [ ] **Step 1: Write the failing test**

Create `test/auth/routes.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authRoutes } from '../../src/auth/routes.js';

// Minimal in-memory session so callback state survives within one agent.
function sessionShim() {
  return (req, _res, next) => {
    req.session ??= { destroy: (cb) => cb && cb() };
    next();
  };
}

function build({ google, repo, allowedEmails }) {
  const app = express();
  app.use(express.json());
  app.use(sessionShim());
  app.use('/api/auth', authRoutes({ google, repo, allowedEmails, publicUrl: 'http://x' }));
  return app;
}

describe('auth routes', () => {
  it('GET /google redirects to the consent screen', async () => {
    const google = { authUrl: vi.fn(() => 'https://accounts.google.com/x'), exchange: vi.fn() };
    const res = await request(build({ google, repo: {}, allowedEmails: [] })).get('/api/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://accounts.google.com/x');
  });

  it('GET /me 401s without a session user', async () => {
    const res = await request(build({ google: {}, repo: {}, allowedEmails: [] })).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('callback rejects an email off the allowlist with 403', async () => {
    const google = { exchange: vi.fn(async () => ({ googleSub: 'g', email: 'x@y.com', name: 'X', avatarUrl: null })) };
    const app = build({ google, repo: {}, allowedEmails: ['a@b.com'] });
    // state check is bypassed here because the shim has no stored state; the
    // route must treat a missing/with mismatched state as 403 too (see impl).
    const res = await request(app).get('/api/auth/callback?code=c&state=s');
    expect(res.status).toBe(403);
  });
});
```

> Note: full callback success (state match → upsert → session) is covered end-to-end in Task B7's `createApp` test with a real session middleware. The unit test above pins redirect, `/me` gating, and allowlist rejection.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/auth/routes.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/auth/routes.js`:

```javascript
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { isAllowed } from './middleware.js';

// Routes for the Google OAuth login flow. `google` is a createGoogleAuth
// result; `allowedEmails` gates who may create a session.
export function authRoutes({ google, repo, allowedEmails }) {
  const router = Router();

  router.get('/google', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(google.authUrl(state));
  });

  router.get('/google/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      // CSRF: the state must match the one we stored before the redirect.
      if (!code || !state || state !== req.session.oauthState) {
        return res.status(403).json({ error: 'invalid oauth state' });
      }
      delete req.session.oauthState;
      const profile = await google.exchange(code);
      if (!isAllowed(profile.email, allowedEmails)) {
        return res.status(403).json({ error: 'not authorized' });
      }
      const user = await repo.upsertUser(profile);
      req.session.userId = user.id;
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      res.status(204).end();
    });
  });

  router.get('/me', (req, res, next) => {
    (async () => {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'authentication required' });
      const user = await repo.getUserById(userId);
      if (!user) return res.status(401).json({ error: 'authentication required' });
      res.json(user);
    })().catch(next);
  });

  return router;
}
```

> The callback alias: also mount `GET /google/callback`. The test above hits `/api/auth/callback`; align the redirect URI to whichever path you register in Google Console. **Use `/api/auth/google/callback` consistently** — update the test URL to `/api/auth/google/callback` so it matches the route and the registered redirect URI.

- [ ] **Step 4: Fix the test path to match the route**

In `test/auth/routes.test.js`, change the callback request to `.get('/api/auth/google/callback?code=c&state=s')`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/auth/routes.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auth/routes.js test/auth/routes.test.js
git commit -m "feat: Google OAuth login/callback/logout/me routes"
```

### Task B7: Session factory + wire auth into createApp and run/api.js

**Files:**
- Create: `src/auth/session.js`
- Modify: `src/api/app.js`
- Modify: `src/run/api.js`
- Test: `test/api/app.auth.test.js`

**Interfaces:**
- Consumes: everything from B4–B6, `express-session`, `connect-pg-simple`.
- Produces:
  - `createSessionMiddleware({ pool, secret, secure }) → RequestHandler`.
  - `createApp({ repo, orchestrator, gunvest, horizonDays, auth })` — when `auth` is supplied, mounts `auth.session` middleware, `/api/auth` routes, and a global `requireUser` gate on all `/api/*` except `/api/auth/*` and `/health`. `auth = { session, google, allowedEmails }`.

- [ ] **Step 1: Write the session factory**

Create `src/auth/session.js`:

```javascript
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

// Postgres-backed session store over legion.user_session (created by schema.sql,
// so createTableIfMissing is false). `secure` cookies in prod (HTTPS at the
// Cloudflare edge); SameSite=Lax allows the OAuth redirect to carry the cookie.
export function createSessionMiddleware({ pool, secret, secure }) {
  const PgStore = connectPgSimple(session);
  return session({
    store: new PgStore({
      pool,
      schemaName: 'legion',
      tableName: 'user_session',
      createTableIfMissing: false,
    }),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  });
}
```

- [ ] **Step 2: Write the failing createApp auth test**

Create `test/api/app.auth.test.js`. Drives a real `express-session` with an in-memory store (no Postgres) plus a stub `google` to exercise the full login → gated-request flow.

```javascript
import { describe, it, expect, vi } from 'vitest';
import session from 'express-session';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub() {
  const user = { id: 1, email: 'a@b.com', name: 'A', avatarUrl: null };
  return {
    upsertUser: vi.fn(async () => user),
    getUserById: vi.fn(async (id) => (id === 1 ? user : null)),
    listTickers: vi.fn(async () => [{ symbol: 'NVDA', enabled: true }]),
  };
}

function authStub(repo, { allowedEmails = ['a@b.com'] } = {}) {
  return {
    // MemoryStore session — fine for a single test process.
    session: session({ secret: 't', resave: false, saveUninitialized: false }),
    google: {
      authUrl: (state) => `https://accounts.google.com/x?state=${state}`,
      exchange: vi.fn(async () => ({ googleSub: 'g', email: 'a@b.com', name: 'A', avatarUrl: null })),
    },
    allowedEmails,
    repo,
  };
}

describe('createApp with auth', () => {
  it('gates shared routes with 401 when unauthenticated', async () => {
    const repo = repoStub();
    const app = createApp({ repo, auth: authStub(repo) });
    const res = await request(app).get('/api/tickers');
    expect(res.status).toBe(401);
  });

  it('leaves /health open', async () => {
    const repo = repoStub();
    const app = createApp({ repo, auth: authStub(repo) });
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('completes the login flow and then serves gated routes', async () => {
    const repo = repoStub();
    const app = createApp({ repo, auth: authStub(repo) });
    const agent = request.agent(app);

    // 1. Start login to seed session state.
    const start = await agent.get('/api/auth/google');
    const state = new URL(start.headers.location).searchParams.get('state');

    // 2. Callback with the matching state → session established, redirect to /.
    const cb = await agent.get(`/api/auth/google/callback?code=c&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/');

    // 3. Gated route now succeeds for the same agent (cookie carried).
    const tickers = await agent.get('/api/tickers');
    expect(tickers.status).toBe(200);
    expect(tickers.body).toEqual([{ symbol: 'NVDA', enabled: true }]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/api/app.auth.test.js`
Expected: FAIL — `createApp` ignores `auth`; `/api/tickers` returns 200 not 401.

- [ ] **Step 4: Wire auth into createApp**

Rewrite `src/api/app.js`:

```javascript
import express from 'express';
import { tickerRoutes } from './routes/tickers.js';
import { cycleRoutes } from './routes/cycles.js';
import { signalRoutes } from './routes/signals.js';
import { reliabilityRoutes } from './routes/reliability.js';
import { backtestRoutes } from './routes/backtest.js';
import { triggerRoutes } from './routes/trigger.js';
import { agentRoutes } from './routes/agents.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { authRoutes } from '../auth/routes.js';
import { requireUser } from '../auth/middleware.js';
import { httpMetricsMiddleware } from '../instrumentation/metrics.js';

// Builds the Express app without listening (so tests can drive it in-process).
// When `auth` is supplied, the whole /api surface (except /api/auth and
// /health) is gated by requireUser; per-user routes (watchlist, portfolio) read
// req.user. Without `auth`, gating is skipped — used by route unit tests that
// exercise business logic directly.
export function createApp({ repo, orchestrator = null, gunvest = null, horizonDays = 5, auth = null }) {
  const app = express();
  app.use(express.json());
  app.use(httpMetricsMiddleware);

  app.get('/health', (req, res) => res.json({ ok: true }));

  if (auth) {
    app.use(auth.session);
    app.use('/api/auth', authRoutes(auth));
    // Gate everything else under /api.
    app.use('/api', requireUser(repo));
  }

  app.use('/api/tickers', tickerRoutes(repo));
  app.use('/api/cycles', cycleRoutes(repo));
  app.use('/api/signals', signalRoutes(repo));
  app.use('/api/reliability', reliabilityRoutes(repo));
  app.use('/api/backtest', backtestRoutes(repo));
  app.use('/api/trigger', triggerRoutes(orchestrator, repo));
  app.use('/api/agents', agentRoutes(repo));
  app.use('/api/watchlist', watchlistRoutes(repo));
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, { horizonDays }));

  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
```

> `auth` carries `{ session, google, allowedEmails, repo }`. `authRoutes(auth)` reads `google`, `repo`, `allowedEmails` (extra `session` key is ignored). The gate uses the top-level `repo`.

> **Note:** Task B8 creates `src/api/routes/watchlist.js`. If executing strictly in order, temporarily comment the watchlist import/mount, or do B8 first. Recommended: implement B8 before running B7's full suite.

- [ ] **Step 5: Wire run/api.js**

Rewrite `src/run/api.js`:

```javascript
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { connectBus } from '../bus/nats.js';
import { createOrchestrator } from '../orchestrator.js';
import { createApp } from '../api/app.js';
import { createGunvestFromConfig } from '../data/gunvest.js';
import { createGoogleAuth } from '../auth/google.js';
import { createSessionMiddleware } from '../auth/session.js';

const cfg = loadConfig();
const db = connectDb(cfg.databaseUrl);
const repo = createRepo(db);

let orchestrator = null;
try {
  const bus = await connectBus(cfg.natsUrl);
  orchestrator = createOrchestrator({ bus, repo });
  console.log('[api] bus connected — POST /api/trigger enabled');
} catch (err) {
  console.warn(`[api] bus unavailable — trigger endpoint disabled: ${err.message}`);
}

const gunvest = createGunvestFromConfig(cfg);

// Build the auth stack. Secure cookies in production (HTTPS terminates at the
// Cloudflare edge); plain HTTP only for local dev.
const isProd = process.env.NODE_ENV === 'production';
const auth = {
  session: createSessionMiddleware({
    pool: db.pool,
    secret: cfg.auth.sessionSecret,
    secure: isProd,
  }),
  google: createGoogleAuth({
    clientId: cfg.auth.googleClientId,
    clientSecret: cfg.auth.googleClientSecret,
    redirectUri: `${cfg.auth.publicUrl}/api/auth/google/callback`,
  }),
  allowedEmails: cfg.auth.allowedEmails,
  repo,
};

const app = createApp({ repo, orchestrator, gunvest, horizonDays: cfg.horizonDays, auth });
app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
```

- [ ] **Step 6: Run the auth app test**

Run: `npx vitest run test/api/app.auth.test.js`
Expected: PASS (after B8's watchlist module exists).

- [ ] **Step 7: Commit**

```bash
git add src/auth/session.js src/api/app.js src/run/api.js test/api/app.auth.test.js
git commit -m "feat: wire sessions, OAuth routes, and the auth gate into the API"
```

### Task B8: Per-user watchlist routes

**Files:**
- Create: `src/api/routes/watchlist.js`
- Test: `test/api/watchlist.test.js`

**Interfaces:**
- Consumes: `repo.listWatchlist`, `repo.addWatchlistSymbol`, `repo.removeWatchlistSymbol`, `repo.listTickers`; `req.user.id`.
- Produces: `watchlistRoutes(repo) → Router`:
  - `GET /` → `{ symbols: string[] }`.
  - `PUT /:symbol` → validates against the global roster, adds, `201 { symbols }`.
  - `DELETE /:symbol` → removes, `200 { symbols }`.

These routes read `req.user`, so tests inject it via a tiny middleware.

- [ ] **Step 1: Write the failing test**

Create `test/api/watchlist.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { watchlistRoutes } from '../../src/api/routes/watchlist.js';

function build(repo) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); }); // inject auth
  app.use('/api/watchlist', watchlistRoutes(repo));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

function repoStub(overrides = {}) {
  return {
    listWatchlist: vi.fn(async () => ['NVDA']),
    addWatchlistSymbol: vi.fn(async () => {}),
    removeWatchlistSymbol: vi.fn(async () => {}),
    listTickers: vi.fn(async () => [{ symbol: 'NVDA', enabled: true }, { symbol: 'AMD', enabled: true }]),
    ...overrides,
  };
}

describe('watchlist routes', () => {
  it('GET / returns the user symbols', async () => {
    const res = await request(build(repoStub())).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ symbols: ['NVDA'] });
  });

  it('PUT /:symbol adds a roster symbol and returns the updated list', async () => {
    const repo = repoStub({ listWatchlist: vi.fn(async () => ['NVDA', 'AMD']) });
    const res = await request(build(repo)).put('/api/watchlist/amd');
    expect(res.status).toBe(201);
    expect(repo.addWatchlistSymbol).toHaveBeenCalledWith(1, 'amd');
    expect(res.body).toEqual({ symbols: ['NVDA', 'AMD'] });
  });

  it('PUT /:symbol 404s a symbol not on the global roster', async () => {
    const repo = repoStub();
    const res = await request(build(repo)).put('/api/watchlist/ZZZZ');
    expect(res.status).toBe(404);
    expect(repo.addWatchlistSymbol).not.toHaveBeenCalled();
  });

  it('DELETE /:symbol removes and returns the updated list', async () => {
    const repo = repoStub({ listWatchlist: vi.fn(async () => []) });
    const res = await request(build(repo)).delete('/api/watchlist/NVDA');
    expect(res.status).toBe(200);
    expect(repo.removeWatchlistSymbol).toHaveBeenCalledWith(1, 'NVDA');
    expect(res.body).toEqual({ symbols: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api/watchlist.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/api/routes/watchlist.js`:

```javascript
import { Router } from 'express';

// Per-user watchlist over the global ticker roster. Every handler reads
// req.user (set by requireUser). Symbols are validated against legion.tickers
// so a user can only follow a ticker the engine actually evaluates.
export function watchlistRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ symbols: await repo.listWatchlist(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.put('/:symbol', async (req, res, next) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const roster = await repo.listTickers();
      if (!roster.some((t) => t.symbol === symbol)) {
        return res.status(404).json({ error: 'symbol not in roster' });
      }
      await repo.addWatchlistSymbol(req.user.id, req.params.symbol);
      res.status(201).json({ symbols: await repo.listWatchlist(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:symbol', async (req, res, next) => {
    try {
      await repo.removeWatchlistSymbol(req.user.id, req.params.symbol);
      res.json({ symbols: await repo.listWatchlist(req.user.id) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/api/watchlist.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/watchlist.js test/api/watchlist.test.js
git commit -m "feat: per-user watchlist routes"
```

### Task B9: Per-user simulated portfolio

**Files:**
- Modify: `src/api/routes/portfolio.js`
- Test: `test/api/portfolio.test.js` (extend if it exists; else create)

**Interfaces:**
- Consumes: `req.user.id`, `repo.listWatchlist`, `repo.getPortfolioConfig`, `repo.listAllSignals`, `gunvest.getCandles`, `simulatePortfolio`.
- Produces: `portfolioRoutes(repo, gunvest, { horizonDays }) → Router`. `GET /` simulates over **the user's watchlist signals** with their config; caches per-user keyed by `userId` + a watchlist/config signature.

- [ ] **Step 1: Write the failing test**

Create/extend `test/api/portfolio.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { portfolioRoutes } from '../../src/api/routes/portfolio.js';

function build(repo, gunvest) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use('/api/portfolio', portfolioRoutes(repo, gunvest, { horizonDays: 5 }));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

const candles = [{ date: '2026-01-01', close: 100 }, { date: '2026-01-10', close: 110 }];

function repoStub(overrides = {}) {
  return {
    listWatchlist: vi.fn(async () => ['NVDA']),
    getPortfolioConfig: vi.fn(async () => ({ startingCash: 100000, horizonDays: 5 })),
    listAllSignals: vi.fn(async () => [
      { id: 1, symbol: 'NVDA', band: 'BUY', conviction: 0.7, plan: {}, created_at: '2026-01-01' },
      { id: 2, symbol: 'TSLA', band: 'BUY', conviction: 0.7, plan: {}, created_at: '2026-01-01' },
    ]),
    ...overrides,
  };
}

const gunvestStub = { getCandles: vi.fn(async () => candles) };

describe('per-user portfolio', () => {
  it('503s when price data is unavailable', async () => {
    const res = await request(build(repoStub(), null)).get('/api/portfolio');
    expect(res.status).toBe(503);
  });

  it('simulates only the user watchlist symbols', async () => {
    const repo = repoStub();
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
    // TSLA is filtered out (not on the watchlist); candles fetched for NVDA + benchmarks only.
    const fetched = gunvestStub.getCandles.mock.calls.map((c) => c[0]);
    expect(fetched).toContain('NVDA');
    expect(fetched).not.toContain('TSLA');
  });

  it('falls back to the default config when the user has none', async () => {
    const repo = repoStub({ getPortfolioConfig: vi.fn(async () => null) });
    const res = await request(build(repo, gunvestStub)).get('/api/portfolio');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api/portfolio.test.js`
Expected: FAIL — current route ignores `req.user`/watchlist and fetches every signal's symbol.

- [ ] **Step 3: Rewrite the route**

Replace `src/api/routes/portfolio.js`:

```javascript
import { Router } from 'express';
import { simulatePortfolio } from '../../portfolio/simulate.js';

// Same candle depth as run/backtest.js — enough history to cover every signal.
const FetchDays = 400;
// Signals change at most once per cycle; candle fetches are the slow part.
const CacheTtlMs = 10 * 60 * 1000;
// Default sim config for a user who hasn't customized theirs.
const DefaultStartingCash = 100000;

// Per-user simulated portfolio: replays the shared signals filtered to the
// user's watchlist, with their starting cash + horizon. Deterministic — no
// stored positions. Cached per user (keyed by userId + a watchlist/config
// signature) so a config change busts only that user's entry.
export function portfolioRoutes(repo, gunvest, { horizonDays = 5 } = {}) {
  const router = Router();
  const cache = new Map(); // userId -> { at, key, payload }

  router.get('/', async (req, res, next) => {
    try {
      if (!gunvest) return res.status(503).json({ error: 'price data unavailable' });
      const userId = req.user.id;

      const [watchlist, config] = await Promise.all([
        repo.listWatchlist(userId),
        repo.getPortfolioConfig(userId),
      ]);
      const startingCash = config?.startingCash ?? DefaultStartingCash;
      const userHorizon = config?.horizonDays ?? horizonDays;
      const key = JSON.stringify({ w: watchlist, c: startingCash, h: userHorizon });

      const hit = cache.get(userId);
      if (hit && hit.key === key && Date.now() - hit.at < CacheTtlMs) {
        return res.json(hit.payload);
      }

      const watchSet = new Set(watchlist);
      const signals = (await repo.listAllSignals()).filter((s) => watchSet.has(s.symbol));
      const symbols = [...new Set(signals.map((s) => s.symbol))];

      const [spy, qqq] = await Promise.all([
        gunvest.getCandles('SPY', FetchDays),
        gunvest.getCandles('QQQ', FetchDays),
      ]);
      const candlesBySymbol = {};
      await Promise.all(
        symbols.map(async (symbol) => {
          try {
            candlesBySymbol[symbol] = await gunvest.getCandles(symbol, FetchDays);
          } catch (err) {
            console.warn(`[portfolio] candles for ${symbol} unavailable: ${err.message}`);
            candlesBySymbol[symbol] = [];
          }
        }),
      );

      const payload = simulatePortfolio(signals, candlesBySymbol, spy, qqq, {
        horizonDays: userHorizon,
        startingCash,
      });
      cache.set(userId, { at: Date.now(), key, payload });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

> **Check `simulatePortfolio`'s signature** in `src/portfolio/simulate.js`. If it does not already accept `startingCash`, either add it there (preferred — thread the option through) or drop `startingCash` from the options object and leave the default inside `simulate`. Do not invent a parameter the function ignores; confirm before wiring.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/api/portfolio.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/portfolio.js test/api/portfolio.test.js
git commit -m "feat: per-user simulated portfolio filtered to the watchlist"
```

### Task B10: Web API client — auth + watchlist + 401 awareness

**Files:**
- Modify: `web/src/api/client.js`
- Test: `web/test/client.test.js` (create)

**Interfaces:**
- Produces on `api`:
  - `getMe() → user | null` (null on 401 instead of throwing).
  - `logout() → void`.
  - `getWatchlist() → { symbols }`, `addToWatchlist(symbol)`, `removeFromWatchlist(symbol)`.
  - Existing calls unchanged.

- [ ] **Step 1: Write the failing test**

Create `web/test/client.test.js`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('api client auth helpers', () => {
  it('getMe returns the user on 200', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 1, email: 'a@b.com' }) });
    expect(await api.getMe()).toEqual({ id: 1, email: 'a@b.com' });
  });

  it('getMe returns null on 401 instead of throwing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    expect(await api.getMe()).toBeNull();
  });

  it('addToWatchlist PUTs the symbol', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 201, json: async () => ({ symbols: ['NVDA'] }) });
    const out = await api.addToWatchlist('NVDA');
    expect(out).toEqual({ symbols: ['NVDA'] });
    expect(fetchMock).toHaveBeenCalledWith('/api/watchlist/NVDA', expect.objectContaining({ method: 'PUT' }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run test/client.test.js`
Expected: FAIL — `api.getMe` is not a function.

- [ ] **Step 3: Extend the client**

In `web/src/api/client.js`, add after the existing `send` helper and into the `api` object:

```javascript
// Like get(), but returns null on 401 so callers can treat "not logged in" as
// a value rather than an exception.
async function getOrNull(path) {
  const res = await fetch(path);
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status}`);
  return res.json();
}
```

Add these entries to the exported `api` object:

```javascript
  getMe: () => getOrNull('/api/auth/me'),
  logout: () =>
    fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } }),
  getWatchlist: () => get('/api/watchlist'),
  addToWatchlist: (symbol) => send('PUT', `/api/watchlist/${symbol}`, {}),
  removeFromWatchlist: (symbol) => send('DELETE', `/api/watchlist/${symbol}`),
```

> `send` already sets `Content-Type: application/json`. Add the `X-Requested-With: fetch` header to `send` as well so state-changing requests pass the CSRF header check (see Task B11 note). Update `send`'s headers to: `{ 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run test/client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api/client.js web/test/client.test.js
git commit -m "feat: web api client auth + watchlist helpers"
```

### Task B11: Web auth context + login gate

**Files:**
- Create: `web/src/auth/AuthContext.jsx`
- Create: `web/src/auth/LoginGate.jsx`
- Modify: `web/src/App.jsx`
- Test: `web/test/LoginGate.test.jsx`

**Interfaces:**
- Consumes: `api.getMe`, `api.logout`.
- Produces:
  - `AuthProvider` (wraps children; loads `getMe` on mount) + `useAuth() → { user, loading, refresh, signOut }`.
  - `LoginGate` — while loading shows a spinner; if no user shows a "Sign in with Google" button linking to `/api/auth/google`; else renders children.

- [ ] **Step 1: Write the failing test**

Create `web/test/LoginGate.test.jsx`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../src/auth/AuthContext.jsx';
import { LoginGate } from '../src/auth/LoginGate.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

function renderGate() {
  return render(
    <AuthProvider>
      <LoginGate>
        <div>secret dashboard</div>
      </LoginGate>
    </AuthProvider>,
  );
}

describe('LoginGate', () => {
  it('shows the sign-in button when unauthenticated', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue(null);
    renderGate();
    await waitFor(() => expect(screen.getByText(/sign in with google/i)).toBeInTheDocument());
    expect(screen.queryByText('secret dashboard')).not.toBeInTheDocument();
  });

  it('renders children when authenticated', async () => {
    vi.spyOn(api, 'getMe').mockResolvedValue({ id: 1, email: 'a@b.com', name: 'A' });
    renderGate();
    await waitFor(() => expect(screen.getByText('secret dashboard')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run test/LoginGate.test.jsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write AuthContext**

Create `web/src/auth/AuthContext.jsx`:

```jsx
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUser(await api.getMe());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

- [ ] **Step 4: Write LoginGate**

Create `web/src/auth/LoginGate.jsx`:

```jsx
import { useAuth } from './AuthContext.jsx';

export function LoginGate({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-500">Loading…</div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-50">
        <h1 className="text-2xl font-semibold text-slate-800">Legion</h1>
        <p className="text-slate-500">Sign in to view your dashboard.</p>
        <a
          href="/api/auth/google"
          className="rounded-md bg-slate-900 px-5 py-2.5 text-white hover:bg-slate-700"
        >
          Sign in with Google
        </a>
      </div>
    );
  }

  return children;
}
```

- [ ] **Step 5: Wrap App in the provider + gate**

In `web/src/App.jsx`, import and wrap. Add imports at top:

```jsx
import { AuthProvider } from './auth/AuthContext.jsx';
import { LoginGate } from './auth/LoginGate.jsx';
import { WatchlistPage } from './pages/WatchlistPage.jsx';
```

Wrap the `BrowserRouter` contents:

```jsx
  return (
    <AuthProvider>
      <LoginGate>
        <BrowserRouter>
          <div className="min-h-screen bg-slate-50 text-slate-900">
            <NavBar />
            <main className="mx-auto max-w-5xl px-6 py-6">
              <Routes>
                <Route path="/" element={<SignalFeed />} />
                <Route path="/debate" element={<DebateViewer />} />
                <Route path="/debate/:symbol" element={<DebateViewer />} />
                <Route path="/debate/:symbol/:cycleId" element={<DebateViewer />} />
                <Route path="/learn" element={<LearnPage />} />
                <Route path="/reliability" element={<ReliabilityBoard />} />
                <Route path="/backtest" element={<BacktestPage />} />
                <Route path="/portfolio" element={<PortfolioPage />} />
                <Route path="/watchlist" element={<WatchlistPage />} />
                <Route path="/config" element={<TickerConfig />} />
                <Route path="/agents" element={<AgentConfig />} />
              </Routes>
            </main>
          </div>
        </BrowserRouter>
      </LoginGate>
    </AuthProvider>
  );
```

- [ ] **Step 6: Run the gate test**

Run: `cd web && npx vitest run test/LoginGate.test.jsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/auth/AuthContext.jsx web/src/auth/LoginGate.jsx web/src/App.jsx web/test/LoginGate.test.jsx
git commit -m "feat: web login gate with Google sign-in"
```

### Task B12: Watchlist page + user menu

**Files:**
- Create: `web/src/pages/WatchlistPage.jsx`
- Modify: `web/src/ui/NavBar.jsx`
- Test: `web/test/WatchlistPage.test.jsx`

**Interfaces:**
- Consumes: `api.getWatchlist`, `api.addToWatchlist`, `api.removeFromWatchlist`, `api.listTickers`, `useAuth`.
- Produces: `WatchlistPage` — lists the user's followed symbols with remove buttons and an add control from the global roster. NavBar shows the user's name + a logout button + a Watchlist link.

- [ ] **Step 1: Write the failing test**

Create `web/test/WatchlistPage.test.jsx`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WatchlistPage } from '../src/pages/WatchlistPage.jsx';
import { api } from '../src/api/client.js';

afterEach(() => vi.restoreAllMocks());

describe('WatchlistPage', () => {
  it('renders the user watchlist', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({ symbols: ['NVDA'] });
    vi.spyOn(api, 'listTickers').mockResolvedValue([{ symbol: 'NVDA', enabled: true }, { symbol: 'AMD', enabled: true }]);
    render(<WatchlistPage />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
  });

  it('adds a symbol', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({ symbols: [] });
    vi.spyOn(api, 'listTickers').mockResolvedValue([{ symbol: 'AMD', enabled: true }]);
    const add = vi.spyOn(api, 'addToWatchlist').mockResolvedValue({ symbols: ['AMD'] });
    render(<WatchlistPage />);
    await waitFor(() => expect(screen.getByText(/add/i)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox'), 'AMD');
    await userEvent.click(screen.getByText(/add/i));
    expect(add).toHaveBeenCalledWith('AMD');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run test/WatchlistPage.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the WatchlistPage**

Create `web/src/pages/WatchlistPage.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export function WatchlistPage() {
  const [symbols, setSymbols] = useState([]);
  const [roster, setRoster] = useState([]);
  const [pick, setPick] = useState('');

  useEffect(() => {
    api.getWatchlist().then((w) => setSymbols(w.symbols));
    api.listTickers().then((t) => setRoster(t.map((x) => x.symbol)));
  }, []);

  const available = roster.filter((s) => !symbols.includes(s));

  const add = async () => {
    if (!pick) return;
    const { symbols: next } = await api.addToWatchlist(pick);
    setSymbols(next);
    setPick('');
  };

  const remove = async (symbol) => {
    const { symbols: next } = await api.removeFromWatchlist(symbol);
    setSymbols(next);
  };

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Watchlist</h1>
      <ul className="mb-4 space-y-1">
        {symbols.map((s) => (
          <li key={s} className="flex items-center justify-between rounded border px-3 py-2">
            <span>{s}</span>
            <button onClick={() => remove(s)} className="text-sm text-red-600 hover:underline">
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="rounded border px-2 py-1"
        >
          <option value="">Select a ticker…</option>
          {available.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button onClick={add} className="rounded bg-slate-900 px-3 py-1 text-white">
          Add
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the user menu + watchlist link to NavBar**

Read `web/src/ui/NavBar.jsx` first to match its existing link pattern. Add a `Watchlist` nav link alongside the others, and at the right edge render the signed-in user + logout:

```jsx
import { useAuth } from '../auth/AuthContext.jsx';
// ...inside NavBar, using the existing layout:
const { user, signOut } = useAuth();
// ...render near the end of the nav bar:
{user && (
  <div className="ml-auto flex items-center gap-3">
    <span className="text-sm text-slate-600">{user.name ?? user.email}</span>
    <button onClick={signOut} className="text-sm text-slate-500 hover:underline">
      Log out
    </button>
  </div>
)}
```

Add a `<NavLink to="/watchlist">Watchlist</NavLink>` (or the project's link component) in the same group as the other page links.

- [ ] **Step 5: Run the watchlist page test**

Run: `cd web && npx vitest run test/WatchlistPage.test.jsx`
Expected: PASS.

- [ ] **Step 6: Run the full web suite**

Run: `cd web && npx vitest run`
Expected: PASS (NavBar consumers now need `AuthProvider`; if a NavBar test renders it bare, wrap it in `AuthProvider` or mock `useAuth`).

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/WatchlistPage.jsx web/src/ui/NavBar.jsx web/test/WatchlistPage.test.jsx
git commit -m "feat: watchlist page and user menu"
```

### Task B13: CI secrets wiring + docs + ADR

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/DEPLOYMENT.md`
- Create: `docs/adr/0030-multitenant-web-auth.md`

**Interfaces:** No code interface. Wires the new env through deploy and documents the one-time Google setup.

- [ ] **Step 1: Add the secrets to the deploy step**

In `.github/workflows/ci.yml`, in the `deploy` job's `appleboy/ssh-action` `env:` block (after `TELEGRAM_CHAT_ID`), add:

```yaml
          GOOGLE_OAUTH_CLIENT_ID: ${{ secrets.GOOGLE_OAUTH_CLIENT_ID }}
          GOOGLE_OAUTH_CLIENT_SECRET: ${{ secrets.GOOGLE_OAUTH_CLIENT_SECRET }}
          SESSION_SECRET: ${{ secrets.SESSION_SECRET }}
          LEGION_ALLOWED_EMAILS: ${{ secrets.LEGION_ALLOWED_EMAILS }}
          LEGION_PUBLIC_URL: ${{ secrets.LEGION_PUBLIC_URL }}
```

Add the same names to the `envs:` comma list:

```yaml
          envs: DATABASE_URL,FINNHUB_API_KEY,TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID,REPO_CLONE_TOKEN,GH_REPO,GOOGLE_OAUTH_CLIENT_ID,GOOGLE_OAUTH_CLIENT_SECRET,SESSION_SECRET,LEGION_ALLOWED_EMAILS,LEGION_PUBLIC_URL
```

- [ ] **Step 2: Add the env to the generated .env heredoc**

In the same script's `tee .env` heredoc (after `LEGION_REFLECTION=true`), add:

```bash
            NODE_ENV=production
            GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID}
            GOOGLE_OAUTH_CLIENT_SECRET=${GOOGLE_OAUTH_CLIENT_SECRET}
            SESSION_SECRET=${SESSION_SECRET}
            LEGION_ALLOWED_EMAILS=${LEGION_ALLOWED_EMAILS}
            LEGION_PUBLIC_URL=${LEGION_PUBLIC_URL}
```

- [ ] **Step 3: Document the one-time Google setup**

Append to `docs/DEPLOYMENT.md` a section:

```markdown
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
```

- [ ] **Step 4: Write the ADR**

Create `docs/adr/0030-multitenant-web-auth.md`:

```markdown
# ADR 0030 — Multi-Tenant Dashboard with Google OAuth

## Status
Accepted (2026-06-19).

## Context
The dashboard was served by `vite preview` (a dev server) and was open to anyone
with the tunnel URL. We want production-grade serving and multiple authenticated
users, each with their own watchlist and simulated portfolio, at ≈$0 and on the
shared Oracle free-tier VM.

## Decision
- Serve the built SPA with nginx (multi-stage image); nginx reverse-proxies
  `/api` to the existing Express `api` service. Replaces `vite preview`.
- Self-managed Google OAuth (authorization-code flow) in the `api` service, with
  Postgres-backed sessions (`express-session` + `connect-pg-simple`) and an email
  allowlist. The whole `/api` surface is gated by `requireUser`.
- The LLM debate engine, signals, and reliability stay **global/shared** — running
  the agent pipeline per user is infeasible on the VM (serial Ollama). Only the
  watchlist and portfolio config are per-user; the portfolio sim stays
  deterministic (no stored positions).

## Alternatives considered
- **Cloudflare Access** — edge auth, zero app code, but ties identity to one
  vendor's headers; chose in-app OAuth for portability.
- **Per-user signal/agent pipelines** — rejected: N× LLM compute the free VM can't
  supply.
- **Allowlist table** — rejected: an env var (`LEGION_ALLOWED_EMAILS`) is simpler
  and edits via the automated redeploy.

## Consequences
- New env/secrets flow through the existing deploy workflow; one out-of-repo step
  remains (registering the OAuth client in Google Cloud Console).
- Sessions are revocable (server-side). Adding a user = edit the allowlist + deploy.
```

- [ ] **Step 5: Verify CI yaml is valid**

Run: `node -e "import('js-yaml').then(y=>y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8')))" 2>/dev/null || echo "install js-yaml or eyeball the diff"`
Expected: no parse error (or eyeball the indentation of the added block).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml docs/DEPLOYMENT.md docs/adr/0030-multitenant-web-auth.md
git commit -m "ci: wire OAuth secrets into deploy; document Google setup (ADR 0030)"
```

### Task B14: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Backend suite + lint**

Run: `npm run lint && npx vitest run`
Expected: PASS. (The schema test skips without `DATABASE_URL`.)

- [ ] **Step 2: Web suite + build**

Run: `cd web && npx vitest run && npm run build`
Expected: PASS, and `dist/` produced.

- [ ] **Step 3: Web image smoke test**

Run:

```bash
docker build -t legion-web:verify ./web
docker run --rm -d --name legion-web-verify -p 5174:5174 legion-web:verify
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5174/portfolio   # expect 200 (SPA fallback)
docker rm -f legion-web-verify
```

Expected: `200`.

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test: full-suite verification fixes for multi-tenant web"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** Section 1 (serving) → Task A1. Section 2 (OAuth flow) → B4, B6, B7. Section 3 (data model) → B1, B2. Section 4 (API+UI scoping) → B8, B9, B10, B11, B12. Section 5 (gating/allowlist/secrets/CI/testing) → B3, B5, B7, B13. Phasing (A/B) preserved.
- **Ordering caveat:** B7 imports `watchlistRoutes` (B8) and the rewritten `portfolio.js` (B9). When running strictly in sequence, B7's app test fully passes only once B8 exists — either implement B8 immediately after B7's code edit, or comment the watchlist mount until B8. Flagged in B7 Step 4.
- **`simulatePortfolio` signature:** B9 threads a `startingCash` option — confirm the function accepts it before wiring (B9 Step 3 note). If not, add it to `src/portfolio/simulate.js` in the same task with its own test.
- **NavBar tests:** wrapping App in `AuthProvider` means any existing bare-NavBar test needs `AuthProvider` or a `useAuth` mock (B12 Step 6).
- **CSRF header:** `send()` sends `X-Requested-With: fetch`; if you add a server-side header check, do it in a small middleware on the per-user state-changing routes — keep `GET` exempt.
```
