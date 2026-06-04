# Legion Phase 3 — Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gestalt observable and configurable: a read/config REST API over the `legion` schema, plus a React dashboard with a **signal feed**, a **debate viewer** (cycle → rounds → per-agent stance/conviction/rationale with live `S/V/κ`), and a **ticker config** page to enable/disable monitored tickers.

**Architecture:** Two new pieces in the legion repo. (1) `legion-api` — a thin Express service exposing read endpoints over Phase 0 tables and ticker config writes; it owns no business logic beyond shaping rows, reusing the Phase 0 `db` client + Phase 2/3 repo methods. (2) `web/` — a Vite + React + Tailwind SPA (mirrors GunVest's frontend stack) that calls the API. The API is data-only; the SPA is presentation-only; they meet at a small typed client. Everything testable: repo methods with a fake pool, routes with `supertest`, the API client with a mocked `fetch`, and components with React Testing Library.

**Tech Stack:** Backend — Node ESM, Express, `supertest` (dev). Frontend — Vite, React 18, Tailwind, Vitest + `@testing-library/react` + `jsdom`. Reuses Phase 0 `db`/`repo`.

**Prerequisites:** Phases 0–2 complete and green. The `legion` schema is populated by live runs (or seed rows in tests).

Spec: `legion/docs/superpowers/specs/2026-06-04-legion-design.md` (§7 dashboard — debate viewer, ticker config, signal feed; backtest tab is Phase 4).

---

## Phase 0–2 interfaces this plan depends on (do not redefine)

- `src/db/client.js` → `createDb(pool)` → `{ query(text, params), queryOne(text, params), pool }`, `connectDb(url)`
- `src/db/repo.js` → existing `createCycle/addRound/addVote/addSignal/finishCycle/listEnabledTickers` (extended here)
- `src/config/index.js` → `loadConfig(env)` (extended here with `apiPort`)
- `legion` schema tables (Phase 0): `tickers(symbol, enabled, created_at)`, `cycles(id, symbol, status, started_at, ended_at)`, `rounds(id, cycle_id, round_no, s_score, dispersion, quorum, converged)`, `votes(id, round_id, agent_id, stance, conviction, weight, rationale)`, `signals(id, cycle_id, symbol, band, conviction, plan, created_at)`

---

## File Structure (Phase 3 additions)

```
legion/
  src/
    db/repo.js              # MODIFY: read + ticker-config methods
    config/index.js         # MODIFY: add apiPort
    api/
      app.js                # createApp({ repo }) -> Express app (no listen)
      routes/
        tickers.js          # GET/POST/PATCH /api/tickers
        cycles.js           # GET /api/cycles, GET /api/cycles/:id (debate)
        signals.js          # GET /api/signals
      debate.js             # assembleDebate(repo, cycleId) -> nested cycle+rounds+votes
    run/
      api.js                # process entrypoint (listen)
  test/
    db/repo.read.test.js
    api/debate.test.js
    api/tickers.test.js
    api/cycles.test.js
    api/signals.test.js
  web/
    package.json            # own app (vite/react/tailwind/vitest)
    vite.config.js
    tailwind.config.js
    postcss.config.js
    index.html
    src/
      main.jsx
      App.jsx
      api/client.js         # typed fetch wrapper
      lib/format.js         # stance/band/percent formatting
      pages/
        SignalFeed.jsx
        DebateViewer.jsx
        TickerConfig.jsx
      components/
        RoundCard.jsx
        VoteRow.jsx
    test/
      api/client.test.js
      lib/format.test.js
      pages/SignalFeed.test.jsx
      pages/TickerConfig.test.jsx
      components/RoundCard.test.jsx
```

---

## Task 1: Repo read + ticker-config methods

**Files:**

- Modify: `legion/src/db/repo.js`
- Test: `legion/test/db/repo.read.test.js`

Adds the queries the API needs: list/upsert/toggle tickers, list cycles, fetch a cycle's rounds and a round's votes, and list signals. Each maps to one statement; assembly into a debate tree happens in Task 2.

- [ ] **Step 1: Write the failing test `test/db/repo.read.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { createRepo } from '../../src/db/repo.js';
import { createDb } from '../../src/db/client.js';

function poolReturning(rowsList) {
  let i = 0;
  const calls = [];
  return {
    calls,
    query: vi.fn(async (text, params) => {
      calls.push({ text, params });
      const rows = rowsList[i] ?? [];
      i += 1;
      return { rows };
    }),
  };
}

describe('repo read + config methods', () => {
  it('lists all tickers ordered by symbol', async () => {
    const pool = poolReturning([
      [
        { symbol: 'MU', enabled: true },
        { symbol: 'NVDA', enabled: false },
      ],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listTickers();
    expect(rows).toEqual([
      { symbol: 'MU', enabled: true },
      { symbol: 'NVDA', enabled: false },
    ]);
    expect(pool.calls[0].text).toMatch(/SELECT symbol, enabled FROM legion\.tickers/);
  });

  it('upserts a ticker as enabled', async () => {
    const pool = poolReturning([[{ symbol: 'AMD', enabled: true }]]);
    const repo = createRepo(createDb(pool));
    const row = await repo.upsertTicker('amd');
    expect(row).toEqual({ symbol: 'AMD', enabled: true });
    expect(pool.calls[0].text).toMatch(/INSERT INTO legion\.tickers/);
    expect(pool.calls[0].text).toMatch(/ON CONFLICT/);
    expect(pool.calls[0].params).toEqual(['AMD']);
  });

  it('sets a ticker enabled flag', async () => {
    const pool = poolReturning([[{ symbol: 'NVDA', enabled: false }]]);
    const repo = createRepo(createDb(pool));
    const row = await repo.setTickerEnabled('nvda', false);
    expect(row).toEqual({ symbol: 'NVDA', enabled: false });
    expect(pool.calls[0].text).toMatch(/UPDATE legion\.tickers SET enabled/);
    expect(pool.calls[0].params).toEqual([false, 'NVDA']);
  });

  it('lists recent cycles for a symbol', async () => {
    const pool = poolReturning([[{ id: 9, symbol: 'NVDA', status: 'converged' }]]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listCycles('nvda', 20);
    expect(rows[0].id).toBe(9);
    expect(pool.calls[0].text).toMatch(/FROM legion\.cycles/);
    expect(pool.calls[0].params).toEqual(['NVDA', 20]);
  });

  it('fetches a single cycle', async () => {
    const pool = poolReturning([[{ id: 9, symbol: 'NVDA', status: 'converged' }]]);
    const repo = createRepo(createDb(pool));
    const row = await repo.getCycle(9);
    expect(row).toEqual({ id: 9, symbol: 'NVDA', status: 'converged' });
    expect(pool.calls[0].params).toEqual([9]);
  });

  it('fetches rounds for a cycle ordered by round number', async () => {
    const pool = poolReturning([
      [{ id: 1, round_no: 1, s_score: 1.5, dispersion: 0.1, quorum: 0.8, converged: true }],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.getRounds(9);
    expect(rows[0].round_no).toBe(1);
    expect(pool.calls[0].text).toMatch(/FROM legion\.rounds WHERE cycle_id/);
    expect(pool.calls[0].params).toEqual([9]);
  });

  it('fetches votes for a round', async () => {
    const pool = poolReturning([
      [{ agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' }],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.getVotes(1);
    expect(rows[0].agent_id).toBe('technical');
    expect(pool.calls[0].text).toMatch(/FROM legion\.votes WHERE round_id/);
    expect(pool.calls[0].params).toEqual([1]);
  });

  it('lists recent signals optionally filtered by symbol', async () => {
    const pool = poolReturning([
      [{ id: 3, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, plan: {} }],
    ]);
    const repo = createRepo(createDb(pool));
    const rows = await repo.listSignals('nvda', 50);
    expect(rows[0].band).toBe('STRONG_BUY');
    expect(pool.calls[0].text).toMatch(/FROM legion\.signals/);
    expect(pool.calls[0].params).toEqual(['NVDA', 50]);
  });

  it('lists recent signals across all symbols when symbol is null', async () => {
    const pool = poolReturning([[{ id: 3, symbol: 'MU' }]]);
    const repo = createRepo(createDb(pool));
    await repo.listSignals(null, 50);
    expect(pool.calls[0].text).not.toMatch(/WHERE symbol/);
    expect(pool.calls[0].params).toEqual([50]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/db/repo.read.test.js`
Expected: FAIL — `repo.listTickers is not a function`.

- [ ] **Step 3: Add these methods to `src/db/repo.js`**

Add inside the object returned by `createRepo` (keep all existing methods):

```js
    async listTickers() {
      const { rows } = await db.query(
        `SELECT symbol, enabled FROM legion.tickers ORDER BY symbol`,
      );
      return rows;
    },

    async upsertTicker(symbol) {
      return db.queryOne(
        `INSERT INTO legion.tickers (symbol, enabled) VALUES ($1, true)
         ON CONFLICT (symbol) DO UPDATE SET enabled = true
         RETURNING symbol, enabled`,
        [symbol.toUpperCase()],
      );
    },

    async setTickerEnabled(symbol, enabled) {
      return db.queryOne(
        `UPDATE legion.tickers SET enabled = $1 WHERE symbol = $2
         RETURNING symbol, enabled`,
        [enabled, symbol.toUpperCase()],
      );
    },

    async listCycles(symbol, limit = 20) {
      const { rows } = await db.query(
        `SELECT id, symbol, status, started_at, ended_at
         FROM legion.cycles WHERE symbol = $1
         ORDER BY id DESC LIMIT $2`,
        [symbol.toUpperCase(), limit],
      );
      return rows;
    },

    async getCycle(id) {
      return db.queryOne(
        `SELECT id, symbol, status, started_at, ended_at FROM legion.cycles WHERE id = $1`,
        [id],
      );
    },

    async getRounds(cycleId) {
      const { rows } = await db.query(
        `SELECT id, round_no, s_score, dispersion, quorum, converged
         FROM legion.rounds WHERE cycle_id = $1 ORDER BY round_no`,
        [cycleId],
      );
      return rows;
    },

    async getVotes(roundId) {
      const { rows } = await db.query(
        `SELECT agent_id, stance, conviction, weight, rationale
         FROM legion.votes WHERE round_id = $1 ORDER BY agent_id`,
        [roundId],
      );
      return rows;
    },

    async listSignals(symbol, limit = 50) {
      if (symbol) {
        const { rows } = await db.query(
          `SELECT id, symbol, band, conviction, plan, created_at
           FROM legion.signals WHERE symbol = $1 ORDER BY id DESC LIMIT $2`,
          [symbol.toUpperCase(), limit],
        );
        return rows;
      }
      const { rows } = await db.query(
        `SELECT id, symbol, band, conviction, plan, created_at
         FROM legion.signals ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/db/repo.read.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/repo.js test/db/repo.read.test.js
git commit -m "feat: add legion repo read and ticker-config methods"
```

---

## Task 2: Debate assembler

**Files:**

- Create: `legion/src/api/debate.js`
- Test: `legion/test/api/debate.test.js`

Assembles a cycle into the nested shape the debate viewer renders: the cycle, its rounds in order, and each round's votes. One place owns the tree shape so routes stay trivial.

- [ ] **Step 1: Write the failing test `test/api/debate.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import { assembleDebate } from '../../src/api/debate.js';

describe('assembleDebate', () => {
  it('nests rounds and their votes under the cycle', async () => {
    const repo = {
      getCycle: vi.fn(async () => ({ id: 9, symbol: 'NVDA', status: 'converged' })),
      getRounds: vi.fn(async () => [
        { id: 1, round_no: 1, s_score: 0.2, dispersion: 3, quorum: 0.5, converged: false },
        { id: 2, round_no: 2, s_score: 1.6, dispersion: 0.1, quorum: 0.9, converged: true },
      ]),
      getVotes: vi.fn(async (roundId) =>
        roundId === 1
          ? [{ agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'up' }]
          : [
              {
                agent_id: 'technical',
                stance: 2,
                conviction: 0.9,
                weight: 1,
                rationale: 'still up',
              },
            ],
      ),
    };

    const debate = await assembleDebate(repo, 9);

    expect(debate.id).toBe(9);
    expect(debate.symbol).toBe('NVDA');
    expect(debate.rounds).toHaveLength(2);
    expect(debate.rounds[0].votes[0].agent_id).toBe('technical');
    expect(debate.rounds[1].converged).toBe(true);
    expect(repo.getVotes).toHaveBeenCalledTimes(2);
  });

  it('returns null when the cycle does not exist', async () => {
    const repo = { getCycle: vi.fn(async () => null), getRounds: vi.fn(), getVotes: vi.fn() };
    expect(await assembleDebate(repo, 999)).toBeNull();
    expect(repo.getRounds).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/debate.test.js`
Expected: FAIL — `Cannot find module '../../src/api/debate.js'`.

- [ ] **Step 3: Write `src/api/debate.js`**

```js
// Assembles a cycle into { ...cycle, rounds: [{ ...round, votes: [...] }] }.
// Returns null for an unknown cycle so the route can 404.
export async function assembleDebate(repo, cycleId) {
  const cycle = await repo.getCycle(cycleId);
  if (!cycle) return null;

  const rounds = await repo.getRounds(cycleId);
  const withVotes = await Promise.all(
    rounds.map(async (round) => ({ ...round, votes: await repo.getVotes(round.id) })),
  );
  return { ...cycle, rounds: withVotes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api/debate.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/debate.js test/api/debate.test.js
git commit -m "feat: add debate assembler"
```

---

## Task 3: Express app + ticker routes

**Files:**

- Create: `legion/src/api/app.js`
- Create: `legion/src/api/routes/tickers.js`
- Test: `legion/test/api/tickers.test.js`
- Modify: `legion/package.json` (add `express`, dev `supertest`)

`createApp({ repo })` builds an Express app **without** calling `listen` (so `supertest` can drive it in-process). Ticker routes back the config page: list, add/enable, toggle.

- [ ] **Step 1: Add deps to `package.json` and install**

In `dependencies` add `"express": "^4.19.2"`; in `devDependencies` add `"supertest": "^7.0.0"`. Then `npm install`.

- [ ] **Step 2: Write the failing test `test/api/tickers.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listTickers: vi.fn(async () => [{ symbol: 'NVDA', enabled: true }]),
    upsertTicker: vi.fn(async (s) => ({ symbol: s.toUpperCase(), enabled: true })),
    setTickerEnabled: vi.fn(async (s, e) => ({ symbol: s.toUpperCase(), enabled: e })),
    ...overrides,
  };
}

describe('ticker routes', () => {
  it('GET /api/tickers returns the list', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/tickers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ symbol: 'NVDA', enabled: true }]);
  });

  it('POST /api/tickers adds a ticker', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).post('/api/tickers').send({ symbol: 'amd' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ symbol: 'AMD', enabled: true });
    expect(repo.upsertTicker).toHaveBeenCalledWith('amd');
  });

  it('POST /api/tickers rejects a missing symbol', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).post('/api/tickers').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbol/i);
  });

  it('PATCH /api/tickers/:symbol toggles enabled', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).patch('/api/tickers/NVDA').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ symbol: 'NVDA', enabled: false });
    expect(repo.setTickerEnabled).toHaveBeenCalledWith('NVDA', false);
  });

  it('PATCH rejects a non-boolean enabled', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).patch('/api/tickers/NVDA').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('PATCH 404s an unknown ticker', async () => {
    const app = createApp({ repo: repoStub({ setTickerEnabled: vi.fn(async () => null) }) });
    const res = await request(app).patch('/api/tickers/ZZZZ').send({ enabled: true });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/tickers.test.js`
Expected: FAIL — `Cannot find module '../../src/api/app.js'`.

- [ ] **Step 4: Write `src/api/routes/tickers.js`**

```js
import { Router } from 'express';

export function tickerRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json(await repo.listTickers());
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { symbol } = req.body ?? {};
      if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: 'symbol is required' });
      }
      res.status(201).json(await repo.upsertTicker(symbol));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:symbol', async (req, res, next) => {
    try {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      const row = await repo.setTickerEnabled(req.params.symbol, enabled);
      if (!row) return res.status(404).json({ error: 'ticker not found' });
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 5: Write `src/api/app.js`**

```js
import express from 'express';
import { tickerRoutes } from './routes/tickers.js';

// Builds the Express app without listening (so tests can drive it in-process).
// Routes are mounted from the supplied repo; no other state.
export function createApp({ repo }) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/api/tickers', tickerRoutes(repo));

  // JSON error handler — never leak a stack to the client.
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/api/tickers.test.js`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add src/api/app.js src/api/routes/tickers.js package.json test/api/tickers.test.js
git commit -m "feat: add express app and ticker config routes"
```

---

## Task 4: Cycle / debate routes

**Files:**

- Create: `legion/src/api/routes/cycles.js`
- Modify: `legion/src/api/app.js` (mount cycles)
- Test: `legion/test/api/cycles.test.js`

Backs the debate viewer: list recent cycles for a ticker, and fetch one cycle's full debate tree.

- [ ] **Step 1: Write the failing test `test/api/cycles.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listTickers: vi.fn(async () => []),
    listCycles: vi.fn(async () => [{ id: 9, symbol: 'NVDA', status: 'converged' }]),
    getCycle: vi.fn(async () => ({ id: 9, symbol: 'NVDA', status: 'converged' })),
    getRounds: vi.fn(async () => [
      { id: 1, round_no: 1, s_score: 1.6, dispersion: 0.1, quorum: 0.9, converged: true },
    ]),
    getVotes: vi.fn(async () => [
      { agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'up' },
    ]),
    ...overrides,
  };
}

describe('cycle routes', () => {
  it('GET /api/cycles?symbol=NVDA lists recent cycles', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).get('/api/cycles?symbol=nvda');
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(9);
    expect(repo.listCycles).toHaveBeenCalledWith('nvda', 20);
  });

  it('GET /api/cycles requires a symbol', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/cycles');
    expect(res.status).toBe(400);
  });

  it('GET /api/cycles/:id returns the debate tree', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/cycles/9');
    expect(res.status).toBe(200);
    expect(res.body.rounds[0].votes[0].agent_id).toBe('technical');
  });

  it('GET /api/cycles/:id 404s an unknown cycle', async () => {
    const app = createApp({ repo: repoStub({ getCycle: vi.fn(async () => null) }) });
    const res = await request(app).get('/api/cycles/999');
    expect(res.status).toBe(404);
  });

  it('GET /api/cycles/:id 400s a non-numeric id', async () => {
    const app = createApp({ repo: repoStub() });
    const res = await request(app).get('/api/cycles/abc');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/cycles.test.js`
Expected: FAIL — cycles routes not mounted.

- [ ] **Step 3: Write `src/api/routes/cycles.js`**

```js
import { Router } from 'express';
import { assembleDebate } from '../debate.js';

export function cycleRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const { symbol } = req.query;
      if (!symbol) return res.status(400).json({ error: 'symbol query param is required' });
      res.json(await repo.listCycles(String(symbol), 20));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
      const debate = await assembleDebate(repo, id);
      if (!debate) return res.status(404).json({ error: 'cycle not found' });
      res.json(debate);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Mount cycles in `src/api/app.js`**

Add the import and mount (keep existing):

```js
import { cycleRoutes } from './routes/cycles.js';
```

```js
app.use('/api/cycles', cycleRoutes(repo));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/api/cycles.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/cycles.js src/api/app.js test/api/cycles.test.js
git commit -m "feat: add cycle and debate routes"
```

---

## Task 5: Signal feed route + API entrypoint

**Files:**

- Create: `legion/src/api/routes/signals.js`
- Modify: `legion/src/api/app.js` (mount signals)
- Modify: `legion/src/config/index.js` (add `apiPort`)
- Create: `legion/src/run/api.js`
- Test: `legion/test/api/signals.test.js`

- [ ] **Step 1: Write the failing test `test/api/signals.test.js`**

```js
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/api/app.js';

function repoStub(overrides = {}) {
  return {
    listTickers: vi.fn(async () => []),
    listSignals: vi.fn(async () => [
      { id: 3, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, plan: {} },
    ]),
    ...overrides,
  };
}

describe('signal routes', () => {
  it('GET /api/signals lists across all symbols', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    const res = await request(app).get('/api/signals');
    expect(res.status).toBe(200);
    expect(res.body[0].band).toBe('STRONG_BUY');
    expect(repo.listSignals).toHaveBeenCalledWith(null, 50);
  });

  it('GET /api/signals?symbol=MU filters by symbol', async () => {
    const repo = repoStub();
    const app = createApp({ repo });
    await request(app).get('/api/signals?symbol=mu');
    expect(repo.listSignals).toHaveBeenCalledWith('mu', 50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/signals.test.js`
Expected: FAIL — signals route not mounted.

- [ ] **Step 3: Write `src/api/routes/signals.js`**

```js
import { Router } from 'express';

export function signalRoutes(repo) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol) : null;
      res.json(await repo.listSignals(symbol, 50));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 4: Mount signals in `src/api/app.js`**

```js
import { signalRoutes } from './routes/signals.js';
```

```js
app.use('/api/signals', signalRoutes(repo));
```

- [ ] **Step 5: Add `apiPort` to `src/config/index.js`**

In the returned config object add (reading env with a default):

```js
    apiPort: Number(env.LEGION_API_PORT || '8088'),
```

- [ ] **Step 6: Write `src/run/api.js`**

```js
import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createApp } from '../api/app.js';

const cfg = loadConfig();
const repo = createRepo(connectDb(cfg.databaseUrl));
const app = createApp({ repo });

app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
```

- [ ] **Step 7: Add the API script to `package.json`**

```json
    "api": "node src/run/api.js"
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/api/signals.test.js`
Expected: PASS (2 tests).

- [ ] **Step 9: Run the whole backend suite**

Run: `npm test`
Expected: all Phase 0–3 backend tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/api/routes/signals.js src/api/app.js src/config/index.js src/run/api.js package.json test/api/signals.test.js
git commit -m "feat: add signal feed route and api entrypoint"
```

---

## Task 6: Web app scaffold + API client + formatting

**Files:**

- Create: `legion/web/package.json`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js`, `index.html`
- Create: `legion/web/src/api/client.js`, `legion/web/src/lib/format.js`
- Create: `legion/web/src/index.css`
- Test: `legion/web/test/api/client.test.js`, `legion/web/test/lib/format.test.js`

The `web/` app is a self-contained Vite project (its own `package.json` and test runner) so its React/jsdom toolchain never mixes with the Node backend's. The API client centralizes every backend call behind one typed wrapper; `format.js` holds pure display helpers.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "legion-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.1",
    "@vitejs/plugin-react": "^4.3.1",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.0",
    "postcss": "^8.4.45",
    "tailwindcss": "^3.4.10",
    "vite": "^5.4.3",
    "vitest": "^2.0.5"
  }
}
```

Then from `web/`: `npm install`.

- [ ] **Step 2: Create `web/vite.config.js`**

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:8088' }, // legion-api
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './test/setup.js',
  },
});
```

- [ ] **Step 3: Create `web/test/setup.js`**

```js
import '@testing-library/jest-dom';
```

- [ ] **Step 4: Create `web/tailwind.config.js`, `web/postcss.config.js`, `web/src/index.css`**

`tailwind.config.js`:

```js
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

`postcss.config.js`:

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

`src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 5: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Legion</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Write the failing test `web/test/lib/format.test.js`**

```js
import { describe, it, expect } from 'vitest';
import { pct, stanceLabel, bandColor } from '../../src/lib/format.js';

describe('format helpers', () => {
  it('renders conviction as a percent', () => {
    expect(pct(0.9)).toBe('90%');
    expect(pct(0)).toBe('0%');
  });

  it('labels ordinal stances', () => {
    expect(stanceLabel(2)).toBe('STRONG_BUY');
    expect(stanceLabel(-1)).toBe('SELL');
    expect(stanceLabel(0)).toBe('HOLD');
  });

  it('maps bands to a tailwind text color', () => {
    expect(bandColor('STRONG_BUY')).toMatch(/green/);
    expect(bandColor('STRONG_SELL')).toMatch(/red/);
    expect(bandColor('NO_CONSENSUS')).toMatch(/gray|zinc|slate/);
  });
});
```

- [ ] **Step 7: Write `web/src/lib/format.js`**

```js
const STANCE_LABELS = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

export function pct(x) {
  return `${Math.round((x ?? 0) * 100)}%`;
}

export function stanceLabel(stance) {
  return STANCE_LABELS[String(stance)] ?? 'HOLD';
}

export function bandColor(band) {
  if (band === 'STRONG_BUY' || band === 'BUY') return 'text-green-600';
  if (band === 'STRONG_SELL' || band === 'SELL') return 'text-red-600';
  return 'text-slate-500';
}
```

- [ ] **Step 8: Write the failing test `web/test/api/client.test.js`**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  global.fetch = vi.fn();
});

function ok(body) {
  return { ok: true, json: async () => body };
}

describe('api client', () => {
  it('lists tickers', async () => {
    global.fetch.mockResolvedValue(ok([{ symbol: 'NVDA', enabled: true }]));
    const rows = await api.listTickers();
    expect(global.fetch).toHaveBeenCalledWith('/api/tickers');
    expect(rows[0].symbol).toBe('NVDA');
  });

  it('adds a ticker via POST', async () => {
    global.fetch.mockResolvedValue(ok({ symbol: 'AMD', enabled: true }));
    await api.addTicker('amd');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/tickers');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ symbol: 'amd' });
  });

  it('toggles a ticker via PATCH', async () => {
    global.fetch.mockResolvedValue(ok({ symbol: 'NVDA', enabled: false }));
    await api.setTicker('NVDA', false);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/tickers/NVDA');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ enabled: false });
  });

  it('fetches a debate', async () => {
    global.fetch.mockResolvedValue(ok({ id: 9, rounds: [] }));
    const d = await api.getDebate(9);
    expect(global.fetch).toHaveBeenCalledWith('/api/cycles/9');
    expect(d.id).toBe(9);
  });

  it('throws on a non-ok response', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(api.listSignals()).rejects.toThrow('API GET /api/signals failed: 500');
  });
});
```

- [ ] **Step 9: Write `web/src/api/client.js`**

```js
async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status}`);
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${method} ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  listTickers: () => get('/api/tickers'),
  addTicker: (symbol) => send('POST', '/api/tickers', { symbol }),
  setTicker: (symbol, enabled) => send('PATCH', `/api/tickers/${symbol}`, { enabled }),
  listCycles: (symbol) => get(`/api/cycles?symbol=${encodeURIComponent(symbol)}`),
  getDebate: (id) => get(`/api/cycles/${id}`),
  listSignals: (symbol) =>
    get(symbol ? `/api/signals?symbol=${encodeURIComponent(symbol)}` : '/api/signals'),
};
```

- [ ] **Step 10: Run the web unit tests**

Run (from `web/`): `npx vitest run test/lib/format.test.js test/api/client.test.js`
Expected: PASS (format 3 + client 5).

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/vite.config.js web/tailwind.config.js web/postcss.config.js web/index.html web/src/index.css web/src/api/client.js web/src/lib/format.js web/test
git commit -m "feat: scaffold legion-web with api client and format helpers"
```

---

## Task 7: Components + pages

**Files:**

- Create: `legion/web/src/components/VoteRow.jsx`, `legion/web/src/components/RoundCard.jsx`
- Create: `legion/web/src/pages/SignalFeed.jsx`, `legion/web/src/pages/DebateViewer.jsx`, `legion/web/src/pages/TickerConfig.jsx`
- Test: `legion/web/test/components/RoundCard.test.jsx`, `legion/web/test/pages/SignalFeed.test.jsx`, `legion/web/test/pages/TickerConfig.test.jsx`

Presentational components render the debate; pages fetch via the client and render state. RTL tests cover the rendering and the one interactive page (ticker config). `DebateViewer` is verified in the manual browser pass (Task 8) — it is a thin compose of the tested `RoundCard` over fetched data.

- [ ] **Step 1: Write `web/src/components/VoteRow.jsx`**

```jsx
import { pct, stanceLabel } from '../lib/format.js';

export function VoteRow({ vote }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-1 text-sm">
      <span className="font-medium">{vote.agent_id}</span>
      <span>{stanceLabel(vote.stance)}</span>
      <span className="text-slate-500">conv {pct(vote.conviction)}</span>
      <span className="max-w-[50%] truncate text-slate-400">{vote.rationale}</span>
    </div>
  );
}
```

- [ ] **Step 2: Write the failing test `web/test/components/RoundCard.test.jsx`**

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoundCard } from '../../src/components/RoundCard.jsx';

const round = {
  round_no: 2,
  s_score: 1.62,
  dispersion: 0.12,
  quorum: 0.91,
  converged: true,
  votes: [
    { agent_id: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
    { agent_id: 'news', stance: 1, conviction: 0.8, weight: 1, rationale: 'guidance raise' },
  ],
};

describe('RoundCard', () => {
  it('shows the round number, metrics, and each vote', () => {
    render(<RoundCard round={round} />);
    expect(screen.getByText(/Round 2/i)).toBeInTheDocument();
    expect(screen.getByText(/1.62/)).toBeInTheDocument(); // S
    expect(screen.getByText(/0.12/)).toBeInTheDocument(); // V
    expect(screen.getByText('technical')).toBeInTheDocument();
    expect(screen.getByText('news')).toBeInTheDocument();
  });

  it('marks a converged round', () => {
    render(<RoundCard round={round} />);
    expect(screen.getByText(/converged/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `web/`): `npx vitest run test/components/RoundCard.test.jsx`
Expected: FAIL — `Cannot find module '../../src/components/RoundCard.jsx'`.

- [ ] **Step 4: Write `web/src/components/RoundCard.jsx`**

```jsx
import { VoteRow } from './VoteRow.jsx';

export function RoundCard({ round }) {
  return (
    <div className="mb-4 rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Round {round.round_no}</h3>
        <span className={round.converged ? 'text-green-600' : 'text-amber-600'}>
          {round.converged ? 'converged' : 'unconverged'}
        </span>
      </div>
      <div className="mb-2 flex gap-4 text-xs text-slate-500">
        <span>S {Number(round.s_score).toFixed(2)}</span>
        <span>V {Number(round.dispersion).toFixed(2)}</span>
        <span>κ {Number(round.quorum).toFixed(2)}</span>
      </div>
      {round.votes.map((v) => (
        <VoteRow key={v.agent_id} vote={v} />
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `web/`): `npx vitest run test/components/RoundCard.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Write `web/src/pages/SignalFeed.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { pct, bandColor } from '../lib/format.js';

export function SignalFeed() {
  const [signals, setSignals] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .listSignals()
      .then(setSignals)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Signal feed</h2>
      {signals.length === 0 && <p className="text-slate-400">No signals yet.</p>}
      <ul>
        {signals.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between border-b border-slate-100 py-2"
          >
            <span className="font-medium">{s.symbol}</span>
            <span className={bandColor(s.band)}>{s.band}</span>
            <span className="text-slate-500">conv {pct(s.conviction)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 7: Write the failing test `web/test/pages/SignalFeed.test.jsx`**

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SignalFeed } from '../../src/pages/SignalFeed.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SignalFeed', () => {
  it('renders fetched signals', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue([
      { id: 1, symbol: 'NVDA', band: 'STRONG_BUY', conviction: 0.9, plan: {} },
    ]);
    render(<SignalFeed />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());
    expect(screen.getByText('STRONG_BUY')).toBeInTheDocument();
    expect(screen.getByText('conv 90%')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    vi.spyOn(api, 'listSignals').mockResolvedValue([]);
    render(<SignalFeed />);
    await waitFor(() => expect(screen.getByText(/no signals/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 8: Run test to verify it passes**

Run (from `web/`): `npx vitest run test/pages/SignalFeed.test.jsx`
Expected: PASS (2 tests).

- [ ] **Step 9: Write `web/src/pages/DebateViewer.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { RoundCard } from '../components/RoundCard.jsx';

export function DebateViewer({ symbol }) {
  const [cycles, setCycles] = useState([]);
  const [debate, setDebate] = useState(null);

  useEffect(() => {
    if (symbol)
      api
        .listCycles(symbol)
        .then(setCycles)
        .catch(() => setCycles([]));
  }, [symbol]);

  function open(id) {
    api
      .getDebate(id)
      .then(setDebate)
      .catch(() => setDebate(null));
  }

  return (
    <div className="flex gap-6">
      <div className="w-48 shrink-0">
        <h2 className="mb-2 text-lg font-semibold">Cycles</h2>
        <ul>
          {cycles.map((c) => (
            <li key={c.id}>
              <button className="py-1 text-left text-sm hover:underline" onClick={() => open(c.id)}>
                #{c.id} · {c.status}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1">
        {debate ? (
          <>
            <h2 className="mb-3 text-lg font-semibold">
              {debate.symbol} — cycle #{debate.id} ({debate.status})
            </h2>
            {debate.rounds.map((r) => (
              <RoundCard key={r.round_no} round={r} />
            ))}
          </>
        ) : (
          <p className="text-slate-400">Select a cycle to see the debate.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Write `web/src/pages/TickerConfig.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export function TickerConfig() {
  const [tickers, setTickers] = useState([]);
  const [symbol, setSymbol] = useState('');

  function refresh() {
    api
      .listTickers()
      .then(setTickers)
      .catch(() => setTickers([]));
  }
  useEffect(refresh, []);

  async function add(e) {
    e.preventDefault();
    if (!symbol.trim()) return;
    await api.addTicker(symbol.trim());
    setSymbol('');
    refresh();
  }

  async function toggle(t) {
    await api.setTicker(t.symbol, !t.enabled);
    refresh();
  }

  return (
    <div className="max-w-md">
      <h2 className="mb-3 text-lg font-semibold">Ticker config</h2>
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input
          aria-label="symbol"
          className="flex-1 rounded border border-slate-300 px-2 py-1"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="e.g. NVDA"
        />
        <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">
          Add
        </button>
      </form>
      <ul>
        {tickers.map((t) => (
          <li
            key={t.symbol}
            className="flex items-center justify-between border-b border-slate-100 py-2"
          >
            <span className="font-medium">{t.symbol}</span>
            <button
              className={t.enabled ? 'text-green-600' : 'text-slate-400'}
              onClick={() => toggle(t)}
            >
              {t.enabled ? 'enabled' : 'disabled'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 11: Write the failing test `web/test/pages/TickerConfig.test.jsx`**

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TickerConfig } from '../../src/pages/TickerConfig.jsx';
import { api } from '../../src/api/client.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('TickerConfig', () => {
  it('lists tickers and toggles one', async () => {
    vi.spyOn(api, 'listTickers').mockResolvedValue([{ symbol: 'NVDA', enabled: true }]);
    const setTicker = vi
      .spyOn(api, 'setTicker')
      .mockResolvedValue({ symbol: 'NVDA', enabled: false });

    render(<TickerConfig />);
    await waitFor(() => expect(screen.getByText('NVDA')).toBeInTheDocument());

    fireEvent.click(screen.getByText('enabled'));
    expect(setTicker).toHaveBeenCalledWith('NVDA', false);
  });

  it('adds a ticker from the form', async () => {
    vi.spyOn(api, 'listTickers').mockResolvedValue([]);
    const addTicker = vi
      .spyOn(api, 'addTicker')
      .mockResolvedValue({ symbol: 'AMD', enabled: true });

    render(<TickerConfig />);
    fireEvent.change(screen.getByLabelText('symbol'), { target: { value: 'amd' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => expect(addTicker).toHaveBeenCalledWith('amd'));
  });
});
```

- [ ] **Step 12: Run the page/component tests**

Run (from `web/`): `npx vitest run test/pages/TickerConfig.test.jsx test/components/RoundCard.test.jsx test/pages/SignalFeed.test.jsx`
Expected: PASS (TickerConfig 2 + RoundCard 2 + SignalFeed 2).

- [ ] **Step 13: Commit**

```bash
git add web/src/components web/src/pages web/test/components web/test/pages
git commit -m "feat: add dashboard components and pages"
```

---

## Task 8: App shell, entry, and run docs

**Files:**

- Create: `legion/web/src/App.jsx`, `legion/web/src/main.jsx`
- Modify: `legion/README.md` (Phase 3 run section)
- Modify: `legion/docker-compose.yml` (api + web services)

A minimal tab shell (no router dependency — three tabs in local state) ties the pages together. Verified in the browser since it is presentation wiring over tested units.

- [ ] **Step 1: Write `web/src/App.jsx`**

```jsx
import { useState } from 'react';
import { SignalFeed } from './pages/SignalFeed.jsx';
import { DebateViewer } from './pages/DebateViewer.jsx';
import { TickerConfig } from './pages/TickerConfig.jsx';

const TABS = ['Signals', 'Debate', 'Config'];

export function App() {
  const [tab, setTab] = useState('Signals');
  const [symbol, setSymbol] = useState('NVDA');

  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">Legion</h1>
        <nav className="flex gap-2">
          {TABS.map((t) => (
            <button
              key={t}
              className={`rounded px-3 py-1 ${tab === t ? 'bg-slate-800 text-white' : 'text-slate-600'}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'Debate' && (
        <input
          aria-label="debate-symbol"
          className="mb-4 rounded border border-slate-300 px-2 py-1"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
      )}

      {tab === 'Signals' && <SignalFeed />}
      {tab === 'Debate' && <DebateViewer symbol={symbol} />}
      {tab === 'Config' && <TickerConfig />}
    </div>
  );
}
```

- [ ] **Step 2: Write `web/src/main.jsx`**

```jsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 3: Add api + web services to `docker-compose.yml`**

```yaml
api:
  build: .
  command: npm run api
  env_file: .env
  ports: ['8088:8088']
  depends_on: [nats]
  restart: unless-stopped

web:
  build: ./web
  command: npm run preview -- --host --port 5174
  ports: ['5174:5174']
  depends_on: [api]
  restart: unless-stopped
```

> `web/Dockerfile` (build the SPA, serve with vite preview): `FROM node:20-alpine`, `WORKDIR /app`, `COPY package*.json ./`, `RUN npm ci`, `COPY . .`, `RUN npm run build`, `CMD ["npm","run","preview","--","--host","--port","5174"]`. In production the proxy target should point at the `api` service URL rather than localhost.

- [ ] **Step 4: Add a Phase 3 section to `README.md`**

````markdown
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
````

- [ ] **Step 5: Manual browser verification**

With the API running (`npm run api`) and the schema seeded (run a few cycles from Phase 2, or insert sample rows), start `cd web && npm run dev` and open `http://localhost:5174`:

- **Signals** tab lists recent signals with band colors and conviction.
- **Config** tab: add a ticker, toggle enable/disable — confirm the row updates and `SELECT * FROM legion.tickers;` reflects it.
- **Debate** tab: enter a ticker that has cycles, click a cycle, confirm rounds render with S/V/κ and each agent's stance/conviction/rationale.
  Check the browser console for errors. If `/api` calls 404, confirm the Vite proxy target matches the API port.

- [ ] **Step 6: Run all web tests**

Run (from `web/`): `npm test`
Expected: all web tests pass.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.jsx web/src/main.jsx README.md docker-compose.yml web/Dockerfile
git commit -m "feat: add dashboard app shell and run docs"
```

---

## Phase 3 Done — Handover Notes

Capture for the next session:

- Confirm `signals.plan` round-trips as JSON from `pg` (it is stored via `JSON.stringify`; `pg` may return JSONB as an object already — adjust the client/render if the shape differs).
- Whether a polling/refresh or websocket live-update is wanted on the Signals/Debate tabs (Phase 2 architecture reserved a `WS` channel; deferred here — pages fetch once on mount).
- If ticker count grows, add pagination to `listCycles`/`listSignals` (currently capped at 20/50).
- Auth: the API is unauthenticated (single-user, private VM). Add a token guard before exposing it publicly.

**Next phase:** Phase 4 — backtest + reliability: forward paper-test logging, index comparison (SPY/QQQ), deterministic sub-signal backtest, and the per-agent `ρ_i` Brier loop that feeds `W_i = w_i · ρ_i`. Adds a Backtest tab to this dashboard. Write its own plan via the writing-plans skill.

---

## Self-Review

**Spec coverage (Phase 3 deliverable: debate viewer, ticker config, signal feed):**

- Debate viewer (cycle → rounds → per-agent stance/conviction/rationale + live S/V/κ + convergence) → API Tasks 2/4, UI Task 7 (`DebateViewer` + `RoundCard` + `VoteRow`) ✅
- Ticker config (add/enable/disable) → API Task 3, UI Task 7 (`TickerConfig`) ✅
- Signal feed → API Task 5, UI Task 7 (`SignalFeed`) ✅
- Stack mirrors GunVest (React + Vite + Tailwind), own app → Tasks 6/8 ✅
- Backtest tab explicitly deferred to Phase 4 (matches spec §10 phasing) ✅

**Type consistency:** API row shapes (`{ symbol, enabled }`, cycle `{ id, symbol, status }`, round `{ round_no, s_score, dispersion, quorum, converged }`, vote `{ agent_id, stance, conviction, weight, rationale }`, signal `{ id, symbol, band, conviction, plan }`) flow unchanged repo → route → client → component. `assembleDebate` output `{ ...cycle, rounds: [{ ...round, votes }] }` consumed exactly by `DebateViewer`/`RoundCard`. Client method names (`listTickers/addTicker/setTicker/listCycles/getDebate/listSignals`) match route paths and verbs in Tasks 3–5. `stanceLabel`/`pct`/`bandColor` consume the same ordinals/bands the backend emits (Phase 0 `STANCE`, Phase 1 `buildSignal` bands incl. `NO_CONSENSUS`).

**Boundary discipline:** API is data-only (no consensus logic — reuses repo); SPA is presentation-only (no DB access — only the client). They meet solely at `web/src/api/client.js`, keeping each independently testable (supertest vs. RTL).

**Placeholders:** none — every step has full code. `DebateViewer` and `App` lack dedicated unit tests by design (thin composition over tested units) and are covered by the Task 8 manual browser pass, per UI-testing guidance.
