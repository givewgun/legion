# IBKR Paper-Trading Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-execute Legion signals as real DAY market orders on an IBKR paper account via an order-intent outbox and an executor worker, replacing the internal simulated paper book.

**Architecture:** Emitter writes an `order_intents` row after each signal persists (guarded, never blocks emission). An executor loop inside the emitter process gates on runtime-config kill-switch/dry-run, sizes the intent with the existing `computeSizing` engine against the **actual** IBKR position and equity, submits a DAY market order with `cOID = intent id` (broker-side dedupe), tracks fills, and snapshots account equity. The Client Portal API is reached through an IBeam gateway container. `/api/portfolio` is rebuilt to serve the IBKR-backed book; the old `paper-book.js` fold is deleted.

**Tech Stack:** Node ES modules, Express, Postgres (single `schema.sql`), vitest, undici (new dep, TLS-skipping dispatcher for IBeam's self-signed cert), voyz/ibeam docker image, React + recharts web.

**Spec:** `docs/superpowers/specs/2026-07-03-ibkr-paper-trading-design.md`

## Global Constraints

- ES modules, `import`/`export`, ES2020. camelCase functions, PascalCase module-level constants.
- Named constants, no magic numbers. JSDoc on public APIs.
- Vitest idioms (`expect`/`toBe`/`toEqual`), no node assert. Mock as little as possible; `vi.spyOn` + `vi.restoreAllMocks` over global `vi.mock`.
- All tests for a component in ONE file (e.g. all executor tests in `test/exec/executor.test.js`).
- Conventional commits. NEVER bypass git hooks. Run `npm run lint` before any push.
- Working branch: `claude/ibkr-paper-trading` (already exists, spec committed).
- Runtime-config knobs (spec): `trading_enabled` default **false**, `trading_dry_run` default **true**, `trading_min_order_notional` default **50** USD.
- Paper-account assertion: account id must start with `D` unless `LEGION_ALLOW_LIVE_BROKER=true`.
- DAY market orders only. Whole shares only. Exits signal-driven only.

---

### Task 1: Schema + repo methods for order intents and equity snapshots

**Files:**
- Modify: `src/db/schema.sql` (append after the ADR 0034 block at end of file)
- Modify: `src/db/repo.js` (add methods near the runtime-config block, ~line 848)
- Test: `test/db/repo.test.js` (add describe blocks; check existing file for the established stub-db pattern and follow it)

**Interfaces (Produces — later tasks call exactly these):**
- `repo.addOrderIntent({ signalId, symbol, band, conviction, qualityMult })` → `id` (number)
- `repo.listOrderIntentsByStatus(status)` → rows oldest-first: `[{ id, signalId, symbol, band, conviction, qualityMult, targetWeight, status, skipReason, brokerOrderId, submittedQty, fillQty, fillPrice, error, createdAt }]`
- `repo.updateOrderIntent(id, patch)` — patch keys subset of `{ status, skipReason, brokerOrderId, submittedQty, targetWeight, fillQty, fillPrice, error }`; always bumps `updated_at`
- `repo.listOrderIntents(limit = 100)` → same row shape, newest-first (order log)
- `repo.addEquitySnapshot({ equity, cash })`
- `repo.listEquitySnapshots()` → oldest-first `[{ ts, equity, cash }]`

- [ ] **Step 1: Append schema**

Append to `src/db/schema.sql`:

```sql
-- ── IBKR paper-trading execution (ADR 0035) ──────────────────────────────────
-- Order-intent outbox: the emitter INSERTs one row per emitted signal; the
-- executor worker polls, sizes against the real IBKR position, submits, and
-- records the outcome. status: pending → submitted → filled | skipped | failed.
CREATE TABLE IF NOT EXISTS legion.order_intents (
  id              BIGSERIAL PRIMARY KEY,
  signal_id       BIGINT REFERENCES legion.signals(id),
  symbol          TEXT NOT NULL,
  band            TEXT NOT NULL,
  conviction      NUMERIC,
  quality_mult    NUMERIC,
  target_weight   NUMERIC,
  status          TEXT NOT NULL DEFAULT 'pending',
  skip_reason     TEXT,
  broker_order_id TEXT,
  submitted_qty   NUMERIC,
  fill_qty        NUMERIC,
  fill_price      NUMERIC,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_intents_status ON legion.order_intents (status);

-- Own equity history for the IBKR paper book (CP API history is shallow and
-- resets with the paper account). Executor snapshots hourly in-market + per fill.
CREATE TABLE IF NOT EXISTS legion.paper_equity_snapshots (
  id     BIGSERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  equity NUMERIC NOT NULL,
  cash   NUMERIC
);
```

- [ ] **Step 2: Write failing repo tests**

In `test/db/repo.test.js`, mirror the file's existing stub pattern (a fake `db.query` capturing SQL + params, returning canned rows). Cover: `addOrderIntent` inserts with status defaulting to pending and returns the new id; `listOrderIntentsByStatus('pending')` orders by `created_at ASC` and camelCases columns; `updateOrderIntent` builds a SET clause only from provided patch keys (verify unknown keys throw) and bumps `updated_at`; `listOrderIntents` orders `created_at DESC` with limit; `addEquitySnapshot` / `listEquitySnapshots` round-trip. Example (adapt to the file's stub helpers):

```js
describe('order intents', () => {
  it('addOrderIntent inserts pending and returns id', async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 7 }] }; } };
    const repo = createRepo(db);
    const id = await repo.addOrderIntent({ signalId: 3, symbol: 'AAPL', band: 'BUY', conviction: 0.8, qualityMult: 1.2 });
    expect(id).toBe(7);
    expect(calls[0].sql).toMatch(/INSERT INTO legion\.order_intents/);
    expect(calls[0].params).toEqual([3, 'AAPL', 'BUY', 0.8, 1.2]);
  });

  it('updateOrderIntent patches only given keys', async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    const repo = createRepo(db);
    await repo.updateOrderIntent(7, { status: 'submitted', brokerOrderId: 'X1', submittedQty: 10 });
    expect(calls[0].sql).toMatch(/UPDATE legion\.order_intents SET/);
    expect(calls[0].sql).toMatch(/updated_at = now\(\)/);
    expect(calls[0].params).toContain('submitted');
    await expect(repo.updateOrderIntent(7, { nope: 1 })).rejects.toThrow(/unknown/i);
  });
});
```

- [ ] **Step 3: Run tests, verify FAIL** — `npx vitest run test/db/repo.test.js` → new tests fail with "repo.addOrderIntent is not a function".

- [ ] **Step 4: Implement repo methods**

Add to `createRepo` in `src/db/repo.js` (follow the style of the runtime-config block; one camelCase mapper helper for the row shape):

```js
    // ── IBKR paper-trading execution (ADR 0035) ────────────────────────────────
    // Column → JS patch-key map doubles as the whitelist for updateOrderIntent.
    // (module-level, next to other constants)
```

```js
const OrderIntentColumns = {
  status: 'status', skipReason: 'skip_reason', brokerOrderId: 'broker_order_id',
  submittedQty: 'submitted_qty', targetWeight: 'target_weight',
  fillQty: 'fill_qty', fillPrice: 'fill_price', error: 'error',
};

function mapOrderIntent(r) {
  return {
    id: Number(r.id), signalId: r.signal_id == null ? null : Number(r.signal_id),
    symbol: r.symbol, band: r.band,
    conviction: r.conviction == null ? null : Number(r.conviction),
    qualityMult: r.quality_mult == null ? null : Number(r.quality_mult),
    targetWeight: r.target_weight == null ? null : Number(r.target_weight),
    status: r.status, skipReason: r.skip_reason, brokerOrderId: r.broker_order_id,
    submittedQty: r.submitted_qty == null ? null : Number(r.submitted_qty),
    fillQty: r.fill_qty == null ? null : Number(r.fill_qty),
    fillPrice: r.fill_price == null ? null : Number(r.fill_price),
    error: r.error, createdAt: r.created_at,
  };
}
```

Methods inside `createRepo`:

```js
    async addOrderIntent({ signalId, symbol, band, conviction, qualityMult }) {
      const { rows } = await db.query(
        `INSERT INTO legion.order_intents (signal_id, symbol, band, conviction, quality_mult)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [signalId, symbol, band, conviction, qualityMult],
      );
      return Number(rows[0].id);
    },
    async listOrderIntentsByStatus(status) {
      const { rows } = await db.query(
        `SELECT * FROM legion.order_intents WHERE status = $1 ORDER BY created_at ASC`,
        [status],
      );
      return rows.map(mapOrderIntent);
    },
    async listOrderIntents(limit = 100) {
      const { rows } = await db.query(
        `SELECT * FROM legion.order_intents ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(mapOrderIntent);
    },
    async updateOrderIntent(id, patch) {
      const keys = Object.keys(patch);
      const cols = keys.map((k) => {
        if (!OrderIntentColumns[k]) throw new Error(`updateOrderIntent: unknown key ${k}`);
        return OrderIntentColumns[k];
      });
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await db.query(
        `UPDATE legion.order_intents SET ${sets}, updated_at = now() WHERE id = $1`,
        [id, ...keys.map((k) => patch[k])],
      );
    },
    async addEquitySnapshot({ equity, cash }) {
      await db.query(
        `INSERT INTO legion.paper_equity_snapshots (equity, cash) VALUES ($1, $2)`,
        [equity, cash],
      );
    },
    async listEquitySnapshots() {
      const { rows } = await db.query(
        `SELECT ts, equity, cash FROM legion.paper_equity_snapshots ORDER BY ts ASC`,
      );
      return rows.map((r) => ({ ts: r.ts, equity: Number(r.equity), cash: r.cash == null ? null : Number(r.cash) }));
    },
```

- [ ] **Step 5: Run tests, verify PASS** — `npx vitest run test/db/repo.test.js`
- [ ] **Step 6: Commit** — `git add src/db/schema.sql src/db/repo.js test/db/repo.test.js && git commit -m "feat: add order-intent outbox and equity-snapshot tables + repo methods"`

---

### Task 2: Config — trading/broker blocks + runtime keys

**Files:**
- Modify: `src/config/index.js` (add `trading` + `broker` blocks inside `loadConfig` return, after the `emitter` block)
- Modify: `src/config/runtime-keys.js` (append three keys)
- Test: `test/config/` — find the existing config test file (`ls test/config`) and add cases there; runtime-key coercion is already covered generically, so only defaults need tests.

**Interfaces (Produces):**
- `cfg.trading = { enabled: bool, dryRun: bool, minOrderNotional: number, baseWeight: number, maxPerName: number }`
- `cfg.broker = { gatewayUrl: string|'', allowLive: bool }`
- Runtime keys: `trading_enabled` (bool → `trading.enabled`), `trading_dry_run` (bool → `trading.dryRun`), `trading_min_order_notional` (int → `trading.minOrderNotional`). Dashboard settings form renders them automatically from the registry.

- [ ] **Step 1: Failing test** — in the existing config test file add:

```js
it('trading + broker defaults', () => {
  const cfg = loadConfig({});
  expect(cfg.trading).toEqual({
    enabled: false, dryRun: true, minOrderNotional: 50, baseWeight: 0.05, maxPerName: 0.10,
  });
  expect(cfg.broker).toEqual({ gatewayUrl: '', allowLive: false });
});

it('trading env overrides', () => {
  const cfg = loadConfig({
    LEGION_TRADING_ENABLED: 'true', LEGION_TRADING_DRY_RUN: 'false',
    LEGION_TRADING_MIN_NOTIONAL: '100', IBKR_GATEWAY_URL: 'https://ibeam:5000/v1/api',
  });
  expect(cfg.trading.enabled).toBe(true);
  expect(cfg.trading.dryRun).toBe(false);
  expect(cfg.trading.minOrderNotional).toBe(100);
  expect(cfg.broker.gatewayUrl).toBe('https://ibeam:5000/v1/api');
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run test/config`
- [ ] **Step 3: Implement**

In `src/config/index.js` after the `emitter:` block:

```js
    // IBKR paper-trading execution (ADR 0035). enabled/dryRun are static defaults;
    // the dashboard toggles (trading_enabled / trading_dry_run runtime knobs)
    // override them per executor tick. Rollout: enabled=false → enabled+dryRun
    // (observe logged would-be orders) → dryRun=false for live-paper.
    trading: {
      enabled: env.LEGION_TRADING_ENABLED === 'true',
      dryRun: env.LEGION_TRADING_DRY_RUN !== 'false',
      minOrderNotional: num(env, 'LEGION_TRADING_MIN_NOTIONAL', 50),
      baseWeight: num(env, 'LEGION_TRADING_BASE_WEIGHT', 0.05),
      maxPerName: num(env, 'LEGION_TRADING_MAX_PER_NAME', 0.10),
    },
    // IBeam gateway for the IBKR Client Portal API. Empty url = broker unconfigured
    // (executor idles, /api/portfolio reports gateway down). allowLive must stay
    // false: the adapter refuses non-paper (non-D) accounts without it.
    broker: {
      gatewayUrl: env.IBKR_GATEWAY_URL || '',
      allowLive: env.LEGION_ALLOW_LIVE_BROKER === 'true',
    },
```

In `src/config/runtime-keys.js` append to `RUNTIME_KEYS`:

```js
  { key: 'trading_enabled', type: 'bool', cfgPath: 'trading.enabled', label: 'Paper trading (kill switch)' },
  { key: 'trading_dry_run', type: 'bool', cfgPath: 'trading.dryRun', label: 'Trading dry-run (log only)' },
  {
    key: 'trading_min_order_notional',
    type: 'int',
    cfgPath: 'trading.minOrderNotional',
    label: 'Min order notional (USD)',
  },
];
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run test/config test/api/settings.test.js`
- [ ] **Step 5: Commit** — `git commit -m "feat: add trading + broker config with runtime-config toggles"`

---

### Task 3: Broker interface + IBKR Client Portal adapter

**Files:**
- Create: `src/broker/broker.js` (factory + interface doc)
- Create: `src/broker/ibkr.js` (CP API adapter)
- Modify: `package.json` (`npm i undici` — TLS-skipping dispatcher for IBeam's self-signed cert)
- Test: `test/broker/ibkr.test.js` (ALL broker tests in this one file)

**Interfaces (Produces — executor and API route consume exactly these):**
- `createBrokerFromConfig(cfg, fetchImpl?)` → broker or `null` when `cfg.broker.gatewayUrl` is empty.
- `broker.init()` → `{ accountId }`; throws `live account …` if id doesn't start with `D` and `allowLive` is false. Idempotent; other methods call it lazily.
- `broker.isAuthenticated()` → `boolean` (never throws; false on any error)
- `broker.getAccountSummary()` → `{ accountId, equity, cash }`
- `broker.getPositions()` → `[{ symbol, qty, avgCost, conid }]` (qty ≠ 0 only)
- `broker.placeOrder({ symbol, side: 'BUY'|'SELL', qty, clientOrderId })` → `{ brokerOrderId }` (handles the CP reply-confirmation loop)
- `broker.getOrderStatus(clientOrderId)` → `{ found: boolean, status: 'submitted'|'filled'|'cancelled', fillQty, avgFillPrice }`

- [ ] **Step 1: `npm i undici`** (runtime dep; node's global fetch can't skip TLS verification per-call).

- [ ] **Step 2: Write failing tests** — `test/broker/ibkr.test.js` with a scripted `fetchImpl` (a queue of `{ match, status, json }`):

```js
import { describe, it, expect } from 'vitest';
import { createIbkrBroker } from '../../src/broker/ibkr.js';

const GatewayUrl = 'https://ibeam:5000/v1/api';

// Scripted fetch: each call shifts the next expectation; unmatched path throws.
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    expect(String(url)).toContain(step.path);
    if (step.method) expect(opts.method ?? 'GET').toBe(step.method);
    calls.push({ url: String(url), opts });
    return { ok: step.status ? step.status < 400 : true, status: step.status ?? 200, json: async () => step.json };
  };
  return { impl, calls };
}

const initScript = (accountId = 'DU123456') => [
  { path: '/iserver/auth/status', json: { authenticated: true } },
  { path: '/iserver/accounts', json: { accounts: [accountId], selectedAccount: accountId } },
  { path: '/portfolio/accounts', json: [{ accountId }] }, // CP quirk: primes /portfolio/*
];

describe('ibkr adapter', () => {
  it('init resolves paper account', async () => {
    const { impl } = scriptedFetch(initScript());
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.init()).toEqual({ accountId: 'DU123456' });
  });

  it('init throws on live account without allowLive', async () => {
    const { impl } = scriptedFetch(initScript('U999'));
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    await expect(b.init()).rejects.toThrow(/live account/i);
  });

  it('placeOrder resolves conid, answers reply dialogs, returns order id', async () => {
    const { impl, calls } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/secdef/search', json: [{ conid: 265598, symbol: 'AAPL' }] },
      { path: '/iserver/account/DU123456/orders', method: 'POST', json: [{ id: 'reply-1', message: ['are you sure'] }] },
      { path: '/iserver/reply/reply-1', method: 'POST', json: [{ order_id: '987', order_status: 'Submitted' }] },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    const r = await b.placeOrder({ symbol: 'AAPL', side: 'BUY', qty: 10, clientOrderId: 'intent-7' });
    expect(r).toEqual({ brokerOrderId: '987' });
    const orderBody = JSON.parse(calls.find((c) => c.url.includes('/orders')).opts.body);
    expect(orderBody.orders[0]).toMatchObject({ conid: 265598, orderType: 'MKT', side: 'BUY', quantity: 10, tif: 'DAY', cOID: 'intent-7' });
  });

  it('getOrderStatus finds by order_ref and normalizes status', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/iserver/account/orders', json: { orders: [{ orderId: 987, order_ref: 'intent-7', status: 'Filled', filledQuantity: 10, avgPrice: 190.5 }] } },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getOrderStatus('intent-7')).toEqual({ found: true, status: 'filled', fillQty: 10, avgFillPrice: 190.5 });
  });

  it('getAccountSummary maps netliquidation/totalcashvalue', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/portfolio/DU123456/summary', json: { netliquidation: { amount: 100500 }, totalcashvalue: { amount: 40000 } } },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getAccountSummary()).toEqual({ accountId: 'DU123456', equity: 100500, cash: 40000 });
  });

  it('getPositions maps and drops zero rows; conid cache avoids re-search', async () => {
    const { impl } = scriptedFetch([
      ...initScript(),
      { path: '/portfolio/DU123456/positions/0', json: [
        { conid: 265598, ticker: 'AAPL', position: 10, avgCost: 180 },
        { conid: 1, ticker: 'OLD', position: 0, avgCost: 50 },
      ] },
    ]);
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: impl });
    expect(await b.getPositions()).toEqual([{ symbol: 'AAPL', qty: 10, avgCost: 180, conid: 265598 }]);
  });

  it('isAuthenticated false on transport error, true when authenticated', async () => {
    const b = createIbkrBroker({ gatewayUrl: GatewayUrl, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await b.isAuthenticated()).toBe(false);
  });
});
```

Also test: unfilled/cancelled status maps (`'Cancelled'`/`'Inactive'` → `cancelled`, `'Submitted'`/`'PreSubmitted'` → `submitted`), `getOrderStatus` returns `{ found: false }` when no `order_ref` matches, reply loop caps at `MaxReplyRounds = 5` then throws, conid search with no match throws `unknown symbol`.

- [ ] **Step 3: Run, verify FAIL** — `npx vitest run test/broker/ibkr.test.js` → "Cannot find module".

- [ ] **Step 4: Implement `src/broker/ibkr.js`**

```js
// IBKR Client Portal Web API adapter, reached through an IBeam gateway container
// (ADR 0035). IBeam owns login + session keepalive; this adapter only makes
// authenticated REST calls. The gateway serves HTTPS with a self-signed cert, so
// the default fetch uses an undici dispatcher that skips TLS verification for
// gateway calls ONLY (never a global override). All methods lazily init():
// account discovery + the paper-account assertion happen before any trade call.
import { Agent, fetch as undiciFetch } from 'undici';

// CP order placement can return a chain of precautionary dialogs; each POST
// /iserver/reply answers one. Cap the chain so a misbehaving gateway can't loop.
const MaxReplyRounds = 5;
const PaperAccountPrefix = 'D';

const StatusMap = {
  filled: 'filled',
  cancelled: 'cancelled',
  inactive: 'cancelled',
  submitted: 'submitted',
  presubmitted: 'submitted',
  pendingsubmit: 'submitted',
};

export function createIbkrBroker({ gatewayUrl, fetchImpl, allowLive = false, logger = console }) {
  const base = gatewayUrl.replace(/\/$/, '');
  const fetcher =
    fetchImpl ??
    ((url, opts) =>
      undiciFetch(url, { ...opts, dispatcher: new Agent({ connect: { rejectUnauthorized: false } }) }));

  let accountId = null;
  const conidCache = new Map(); // symbol -> conid

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`IBKR ${method} ${path} -> ${res.status}`);
    return res.json();
  }

  async function init() {
    if (accountId) return { accountId };
    const auth = await call('/iserver/auth/status', { method: 'POST' }).catch(() => call('/iserver/auth/status'));
    if (!auth?.authenticated) throw new Error('IBKR gateway not authenticated');
    const acct = await call('/iserver/accounts');
    const id = acct?.selectedAccount ?? acct?.accounts?.[0];
    if (!id) throw new Error('IBKR: no account returned');
    if (!id.startsWith(PaperAccountPrefix) && !allowLive) {
      throw new Error(`IBKR: refusing live account ${id} (set LEGION_ALLOW_LIVE_BROKER=true to override)`);
    }
    await call('/portfolio/accounts'); // primes /portfolio/* endpoints (CP quirk)
    accountId = id;
    return { accountId };
  }

  async function resolveConid(symbol) {
    if (conidCache.has(symbol)) return conidCache.get(symbol);
    const results = await call(`/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`);
    const hit = (results ?? []).find((r) => r.symbol === symbol) ?? results?.[0];
    if (!hit?.conid) throw new Error(`IBKR: unknown symbol ${symbol}`);
    const conid = Number(hit.conid);
    conidCache.set(symbol, conid);
    return conid;
  }

  return {
    init,

    async isAuthenticated() {
      try {
        const auth = await call('/iserver/auth/status', { method: 'POST' }).catch(() => call('/iserver/auth/status'));
        return !!auth?.authenticated;
      } catch {
        return false;
      }
    },

    async getAccountSummary() {
      await init();
      const s = await call(`/portfolio/${accountId}/summary`);
      return {
        accountId,
        equity: Number(s?.netliquidation?.amount ?? 0),
        cash: Number(s?.totalcashvalue?.amount ?? 0),
      };
    },

    async getPositions() {
      await init();
      const rows = await call(`/portfolio/${accountId}/positions/0`);
      return (rows ?? [])
        .filter((p) => Number(p.position) !== 0)
        .map((p) => ({
          symbol: p.ticker ?? p.contractDesc,
          qty: Number(p.position),
          avgCost: Number(p.avgCost ?? 0),
          conid: Number(p.conid),
        }));
    },

    async placeOrder({ symbol, side, qty, clientOrderId }) {
      await init();
      const conid = await resolveConid(symbol);
      let resp = await call(`/iserver/account/${accountId}/orders`, {
        method: 'POST',
        body: { orders: [{ conid, orderType: 'MKT', side, quantity: qty, tif: 'DAY', cOID: clientOrderId }] },
      });
      for (let round = 0; round < MaxReplyRounds; round++) {
        const first = Array.isArray(resp) ? resp[0] : resp;
        if (first?.order_id) return { brokerOrderId: String(first.order_id) };
        if (!first?.id) throw new Error(`IBKR: unexpected order response ${JSON.stringify(resp)}`);
        logger.warn?.(`[ibkr] confirming order dialog for ${symbol}: ${JSON.stringify(first.message ?? [])}`);
        resp = await call(`/iserver/reply/${first.id}`, { method: 'POST', body: { confirmed: true } });
      }
      throw new Error('IBKR: order confirmation loop exceeded MaxReplyRounds');
    },

    async getOrderStatus(clientOrderId) {
      await init();
      const data = await call('/iserver/account/orders');
      const o = (data?.orders ?? []).find((x) => x.order_ref === clientOrderId);
      if (!o) return { found: false };
      const status = StatusMap[String(o.status ?? '').toLowerCase()] ?? 'submitted';
      return {
        found: true,
        status,
        fillQty: Number(o.filledQuantity ?? 0),
        avgFillPrice: Number(o.avgPrice ?? o.average_price ?? 0),
      };
    },
  };
}
```

**Note for implementer:** `/iserver/auth/status` is a POST in current CP docs but some gateway builds accept GET only — the `.catch(() => call(...))` fallback covers both; keep it.

- [ ] **Step 5: Implement `src/broker/broker.js`**

```js
// Broker abstraction (ADR 0035). One instance-level account per deployment.
// v1 ships the IBKR Client Portal adapter; an InnovestX (Settrade) adapter is a
// future sibling implementing the same surface:
//   init() -> { accountId }
//   isAuthenticated() -> boolean (never throws)
//   getAccountSummary() -> { accountId, equity, cash }
//   getPositions() -> [{ symbol, qty, avgCost, conid }]
//   placeOrder({ symbol, side, qty, clientOrderId }) -> { brokerOrderId }
//   getOrderStatus(clientOrderId) -> { found, status: submitted|filled|cancelled, fillQty, avgFillPrice }
import { createIbkrBroker } from './ibkr.js';

/** Returns a broker for the configured gateway, or null when unconfigured. */
export function createBrokerFromConfig(cfg, fetchImpl) {
  if (!cfg.broker?.gatewayUrl) return null;
  return createIbkrBroker({
    gatewayUrl: cfg.broker.gatewayUrl,
    allowLive: cfg.broker.allowLive,
    fetchImpl,
  });
}
```

- [ ] **Step 6: Run, verify PASS** — `npx vitest run test/broker/ibkr.test.js`
- [ ] **Step 7: Commit** — `git commit -m "feat: add broker abstraction with IBKR Client Portal adapter"`

---

### Task 4: Emitter writes order intents

**Files:**
- Modify: `src/emit/emitter.js` — in `finalize()`, immediately after `const signalId = await repo.addSignal(...)` (~line 524)
- Test: `test/emit/emitter.test.js` (add cases to the existing file; reuse its existing fake repo/bus fixtures)

**Interfaces:**
- Consumes: `repo.addOrderIntent` (Task 1).
- Produces: one pending intent per emitted signal carrying `{ signalId, symbol, band, conviction, qualityMult }`.

- [ ] **Step 1: Failing tests** — in `test/emit/emitter.test.js`, extend the existing fake repo with `addOrderIntent: vi.fn()` and add two cases to the finalize-path describe block (reuse however the file currently drives a cycle to finalize):

```js
it('writes an order intent after persisting the signal', async () => {
  // drive an existing finalize fixture, then:
  expect(repo.addOrderIntent).toHaveBeenCalledWith(expect.objectContaining({
    signalId: expect.any(Number),
    symbol: 'AAPL',
    band: expect.any(String),
    conviction: expect.any(Number),
    qualityMult: expect.any(Number),
  }));
});

it('intent write failure never blocks emission', async () => {
  repo.addOrderIntent.mockRejectedValue(new Error('db down'));
  // drive finalize; assert the signal still persisted and the cycle finished:
  expect(repo.addSignal).toHaveBeenCalled();
  expect(repo.finishCycle).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run test/emit/emitter.test.js`
- [ ] **Step 3: Implement** — in `finalize()` after the `addSignal` call:

```js
    // Order-intent outbox (ADR 0035): hand the emitted signal to the executor.
    // Guarded like the entryPrice/quality fetches — a failed write logs loudly
    // and never blocks emission (visible later as a signal without an intent).
    try {
      await repo.addOrderIntent?.({
        signalId,
        symbol: entry.symbol,
        band: signal.band,
        conviction: signal.conviction,
        qualityMult,
      });
    } catch (err) {
      logger.error(`[emitter] order intent write failed for ${entry.symbol}: ${err.message}`);
    }
```

(`signal.band` / `signal.conviction` are the same fields `buildPaperBook` reads off persisted signals; verify against `buildSignal` in `src/emit/plan.js` and adjust the property names ONLY if they differ there.)

- [ ] **Step 4: Run, verify PASS** — `npx vitest run test/emit` (whole dir — recovery replay also exercises finalize).
- [ ] **Step 5: Commit** — `git commit -m "feat: emit order intents to the execution outbox on signal finalize"`

---

### Task 5: Executor worker — gates, sizing, submission

**Files:**
- Create: `src/exec/executor.js`
- Test: `test/exec/executor.test.js` (ALL executor tests live here, including Task 6's)

**Interfaces:**
- Consumes: repo methods (Task 1), broker surface (Task 3), `computeSizing` (`src/sizing/engine.js`), `applyRuntimeOverrides` (`src/config/runtime-overrides.js`), `gunvest.getPrice(symbol)` → `{ price }`.
- Produces: `createExecutor({ repo, broker, gunvest, cfg, logger?, clock?, intervalMs? })` → `{ start(), stop(), tick() }`. `tick()` is the whole per-loop pipeline, exposed for tests and awaited internally by the interval. Task 7 calls `start()`.

**Executor rules (from spec):**
1. Reload runtime overrides each tick: `applyRuntimeOverrides(cfg, await repo.getRuntimeConfig()).trading`.
2. `enabled === false` → do nothing (intents stay pending). Log only on transition.
3. Process `submitted` intents first (fill tracking — Task 6), then `pending` oldest-first, strictly sequential.
4. Per pending intent: fetch `getAccountSummary()` + `getPositions()` + `gunvest.getPrice(symbol)`; any failure → leave pending (retry next tick), log.
5. `computeSizing({ signal: { band, conviction, symbol }, qualityMult, position: { shares, avgCost }, livePrice, portfolioValue: equity, config: { baseWeight, maxPerName } })` using the **actual IBKR position**. Persist `targetWeight` on the intent.
6. Whole shares: `qty = Math.round(Math.abs(deltaShares))`; SELL qty capped at held shares. Skip conditions → `status='skipped'`: `action === 'hold'` or `qty === 0` or `|deltaUSD| < minOrderNotional` → `skip_reason='dust'`; dry-run → full pipeline, no submission, `skip_reason='dry-run'` with `submittedQty` = would-be qty.
7. Submit `placeOrder({ symbol, side, qty, clientOrderId: String(intent.id) })` → `status='submitted'`, store `brokerOrderId`, `submittedQty`.
8. `placeOrder` throws → `status='failed'`, `error` = message. NO auto-retry (a broker rejection carries information). Transport-level failures before submission (step 4) are retried by staying pending — the distinction is: reached `placeOrder` and threw → failed; couldn't gather state → still pending.

- [ ] **Step 1: Write failing tests** — `test/exec/executor.test.js`. Build tiny in-memory fakes (no vi.mock): a fake repo backed by an array of intents, fake broker recording `placeOrder` calls, fake gunvest with fixed prices. Runtime config via `repo.getRuntimeConfig` returning e.g. `{ trading_enabled: 'true', trading_dry_run: 'false' }`. Cases:

```js
// helpers
const baseCfg = () => loadConfig({}); // trading defaults: enabled=false, dryRun=true
const mkIntent = (over = {}) => ({ id: 1, signalId: 9, symbol: 'AAPL', band: 'BUY', conviction: 1, qualityMult: 1, status: 'pending', ...over });

it('kill switch off: pending intents untouched', ...);          // enabled=false → no broker calls, intent stays pending
it('dry-run: sizes, marks skipped(dry-run) with would-be qty', ...); // enabled=true, dryRun=true → no placeOrder, skipReason 'dry-run', submittedQty > 0, targetWeight persisted
it('BUY intent submits rounded qty with cOID = intent id', ...);
  // equity 100000, price 200, conviction 1, qualityMult 1, baseWeight .05 → target 5000 → 25 shares
  // expect placeOrder({ symbol:'AAPL', side:'BUY', qty:25, clientOrderId:'1' }); status submitted
it('SELL/NO_CONSENSUS: closes actual position, qty capped at held shares', ...);
  // band NO_CONSENSUS, broker position { qty: 30 } → SELL 30
it('dust: |deltaUSD| below minOrderNotional → skipped(dust)', ...);
it('hold inside rebalance band → skipped(dust)', ...);
it('equity fetch failure: intent stays pending, no order', ...);
it('placeOrder rejection → failed with error text', ...);
it('processes intents oldest-first, sequentially', ...);
```

Write each of these fully (arrange fakes, call `await executor.tick()`, assert intent row + broker calls). No skeletons in the actual test file.

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run test/exec/executor.test.js`
- [ ] **Step 3: Implement `src/exec/executor.js`**

```js
// Executor worker (ADR 0035): drains the order-intent outbox into real DAY
// market orders on the IBKR paper account. Runs inside the emitter process on a
// poll interval. Sequential by design — one intent at a time, so per-symbol
// ordering is inherent and a mid-crash leaves at most one order in flight,
// recoverable via cOID (= intent id) broker-side dedupe.
import { computeSizing } from '../sizing/engine.js';
import { applyRuntimeOverrides } from '../config/runtime-overrides.js';

const DefaultIntervalMs = 15000;
const SnapshotEveryMs = 3600000; // hourly while the US market is open
const HoldActions = new Set(['hold']);

export function createExecutor({
  repo, broker, gunvest, cfg,
  logger = console, clock = () => new Date(), intervalMs = DefaultIntervalMs,
}) {
  let timer = null;
  let ticking = false;
  let lastSnapshotMs = 0;
  let lastEnabled = null;

  async function tradingCfg() {
    const overrides = await repo.getRuntimeConfig();
    return applyRuntimeOverrides(cfg, overrides, { warn: logger.warn?.bind(logger) ?? (() => {}) }).trading;
  }

  async function processPending(intent, trading) {
    let equity, positions, price;
    try {
      [{ equity }, positions, price] = await Promise.all([
        broker.getAccountSummary(),
        broker.getPositions(),
        gunvest.getPrice(intent.symbol).then((p) => p?.price),
      ]);
    } catch (err) {
      logger.warn?.(`[executor] state fetch failed for intent ${intent.id} (${intent.symbol}): ${err.message}`);
      return; // stays pending; retried next tick
    }
    if (!(equity > 0) || !(price > 0)) {
      logger.warn?.(`[executor] unusable equity/price for intent ${intent.id}; holding`);
      return;
    }

    const held = positions.find((p) => p.symbol === intent.symbol);
    const sized = computeSizing({
      signal: { band: intent.band, conviction: intent.conviction, symbol: intent.symbol },
      qualityMult: intent.qualityMult ?? 1,
      position: held ? { shares: held.qty, avgCost: held.avgCost } : null,
      livePrice: price,
      portfolioValue: equity,
      config: { baseWeight: trading.baseWeight, maxPerName: trading.maxPerName },
    });

    const side = sized.deltaShares >= 0 ? 'BUY' : 'SELL';
    let qty = Math.round(Math.abs(sized.deltaShares));
    if (side === 'SELL' && held) qty = Math.min(qty, held.qty);

    if (HoldActions.has(sized.action) || qty === 0 || Math.abs(sized.deltaUSD) < trading.minOrderNotional) {
      await repo.updateOrderIntent(intent.id, { status: 'skipped', skipReason: 'dust', targetWeight: sized.targetWeight });
      return;
    }
    if (trading.dryRun) {
      logger.info?.(`[executor] dry-run: would ${side} ${qty} ${intent.symbol} (intent ${intent.id}, target ${sized.targetWeight.toFixed(4)})`);
      await repo.updateOrderIntent(intent.id, { status: 'skipped', skipReason: 'dry-run', submittedQty: qty, targetWeight: sized.targetWeight });
      return;
    }
    try {
      const { brokerOrderId } = await broker.placeOrder({
        symbol: intent.symbol, side, qty, clientOrderId: String(intent.id),
      });
      await repo.updateOrderIntent(intent.id, {
        status: 'submitted', brokerOrderId, submittedQty: qty, targetWeight: sized.targetWeight,
      });
      logger.info?.(`[executor] submitted ${side} ${qty} ${intent.symbol} (intent ${intent.id}, order ${brokerOrderId})`);
    } catch (err) {
      // Reached the broker and was rejected: terminal — a rejection carries
      // information a human should read. Transport failures upstream stay pending.
      await repo.updateOrderIntent(intent.id, { status: 'failed', error: err.message, targetWeight: sized.targetWeight });
      logger.error(`[executor] order failed for intent ${intent.id} (${intent.symbol}): ${err.message}`);
    }
  }

  async function tick() {
    const trading = await tradingCfg();
    if (trading.enabled !== lastEnabled) {
      logger.info?.(`[executor] trading ${trading.enabled ? 'ENABLED' : 'disabled'}${trading.dryRun ? ' (dry-run)' : ''}`);
      lastEnabled = trading.enabled;
    }
    if (!trading.enabled) return;

    await trackSubmitted(); // Task 6
    for (const intent of await repo.listOrderIntentsByStatus('pending')) {
      await processPending(intent, trading);
    }
    await maybeSnapshot(); // Task 6
  }

  // trackSubmitted / maybeSnapshot / isUsMarketHours implemented in Task 6.

  async function guardedTick() {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
      await tick();
    } catch (err) {
      logger.error(`[executor] tick failed: ${err.message}`);
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      timer = setInterval(guardedTick, intervalMs);
      guardedTick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick: guardedTick,
  };
}
```

For this task, stub `trackSubmitted` and `maybeSnapshot` as no-op functions with a `// Task 6` comment so the file runs.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run test/exec/executor.test.js`
- [ ] **Step 5: Commit** — `git commit -m "feat: add executor worker draining order intents into IBKR orders"`

---

### Task 6: Executor — fill tracking, crash recovery, equity snapshots

**Files:**
- Modify: `src/exec/executor.js` (replace the Task 5 stubs)
- Test: `test/exec/executor.test.js` (extend the same file)

**Interfaces:**
- Consumes: `broker.getOrderStatus(clientOrderId)` (Task 3), `repo.addEquitySnapshot` (Task 1).
- Produces: nothing new externally; completes the `tick()` contract.

- [ ] **Step 1: Failing tests** — add to `test/exec/executor.test.js`:

```js
it('submitted intent fills: records fill qty/price, snapshots equity', ...);
  // broker.getOrderStatus -> { found:true, status:'filled', fillQty:25, avgFillPrice:198.4 }
  // expect updateOrderIntent(id, { status:'filled', fillQty:25, fillPrice:198.4 })
  // expect repo.addEquitySnapshot called once (post-fill snapshot)
it('submitted intent still resting: left submitted (overnight order)', ...);
it('submitted intent cancelled/expired: marked failed with reason', ...);
it('crash recovery: submitted intent whose cOID is unknown to broker → failed(order lost)', ...);
  // getOrderStatus -> { found:false }
it('hourly in-market snapshot: taken when >1h since last and market open; skipped off-hours', ...);
  // inject clock: 2026-07-02T15:00:00-04:00 (open, Thu) vs 2026-07-02T22:00:00-04:00 (closed)
it('snapshot failure logs but does not fail the tick', ...);
```

Write these fully in the test file with the fakes from Task 5 (fake broker gets a settable `orderStatusByCoid` map; fake repo records snapshots).

- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement** — replace the stubs in `src/exec/executor.js`:

```js
  // US regular session in exchange time, DST-correct via the IANA zone.
  function isUsMarketHours(now) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  }

  async function snapshotEquity() {
    try {
      const { equity, cash } = await broker.getAccountSummary();
      await repo.addEquitySnapshot({ equity, cash });
      lastSnapshotMs = clock().getTime();
    } catch (err) {
      logger.warn?.(`[executor] equity snapshot failed: ${err.message}`);
    }
  }

  async function maybeSnapshot() {
    const now = clock();
    if (!isUsMarketHours(now)) return;
    if (now.getTime() - lastSnapshotMs < SnapshotEveryMs) return;
    await snapshotEquity();
  }

  // Fill tracking doubles as crash recovery: a `submitted` row is re-queried by
  // cOID every tick, so a crash between placeOrder and the DB update cannot
  // double-order (the broker rejects a duplicate cOID) and a lost order surfaces
  // as failed rather than hanging forever.
  async function trackSubmitted() {
    for (const intent of await repo.listOrderIntentsByStatus('submitted')) {
      let st;
      try {
        st = await broker.getOrderStatus(String(intent.id));
      } catch (err) {
        logger.warn?.(`[executor] order status check failed for intent ${intent.id}: ${err.message}`);
        continue;
      }
      if (!st.found) {
        await repo.updateOrderIntent(intent.id, { status: 'failed', error: 'order not found at broker (lost after submit)' });
        continue;
      }
      if (st.status === 'filled') {
        await repo.updateOrderIntent(intent.id, { status: 'filled', fillQty: st.fillQty, fillPrice: st.avgFillPrice });
        logger.info?.(`[executor] filled intent ${intent.id}: ${st.fillQty} ${intent.symbol} @ ${st.avgFillPrice}`);
        await snapshotEquity();
      } else if (st.status === 'cancelled') {
        await repo.updateOrderIntent(intent.id, { status: 'failed', error: 'order cancelled/expired unfilled' });
      }
      // 'submitted' → still resting (e.g. overnight DAY order): leave as-is.
    }
  }
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run test/exec/executor.test.js`
- [ ] **Step 5: Commit** — `git commit -m "feat: executor fill tracking, crash recovery, and equity snapshots"`

---

### Task 7: Wire executor into the emitter service + IBeam compose service

**Files:**
- Modify: `src/run/emitter.js`
- Modify: `docker-compose.prod.yml`, `docker-compose.yml` (read `test/compose-parity.test.js` FIRST and satisfy whatever parity it enforces)
- Modify: `.env.example` if present (`ls -a` to check) — add `IBKR_GATEWAY_URL=`, `LEGION_TRADING_*` entries
- Test: `test/compose-parity.test.js` (existing; must stay green)

**Interfaces:**
- Consumes: `createBrokerFromConfig` (Task 3), `createExecutor` (Tasks 5–6).

- [ ] **Step 1: Wire the executor** — in `src/run/emitter.js` after the emitter `start()` await:

```js
import { createBrokerFromConfig } from '../broker/broker.js';
import { createExecutor } from '../exec/executor.js';
```

```js
// IBKR paper-trading executor (ADR 0035): drains the order-intent outbox this
// emitter writes. Unconfigured gateway or no gunvest → executor stays off and
// intents accumulate as pending (visible on the dashboard order log).
const broker = createBrokerFromConfig(cfg);
if (broker && gunvest) {
  createExecutor({ repo, broker, gunvest, cfg }).start();
  console.log('[emitter] order executor started');
} else {
  console.log('[emitter] order executor disabled (no IBKR_GATEWAY_URL or gunvest)');
}
```

- [ ] **Step 2: IBeam service in compose** — add to `docker-compose.prod.yml` services (and mirror in `docker-compose.yml` per the parity test's rules):

```yaml
  ibeam:
    image: voyz/ibeam:latest
    container_name: legion-ibeam
    env_file: .env.ibeam
    environment:
      TZ: Asia/Bangkok
    restart: unless-stopped
    networks: [legion]
```

`.env.ibeam` (NOT committed — add to `.gitignore` alongside the existing `private/` entry) carries `IBEAM_ACCOUNT` / `IBEAM_PASSWORD` for the paper login. Legion's `.env` gains `IBKR_GATEWAY_URL=https://ibeam:5000/v1/api`. The emitter service needs no compose change (env_file already loads `.env`).

- [ ] **Step 3: Run compose parity + full backend suite** — `npx vitest run test/compose-parity.test.js && npm test`
- [ ] **Step 4: Commit** — `git commit -m "feat: start order executor in emitter service and add IBeam gateway to compose"`

---

### Task 8: Rebuild /api/portfolio as the IBKR-backed book

**Files:**
- Rewrite: `src/api/routes/portfolio.js`
- Delete: `src/portfolio/paper-book.js`, `test/portfolio/paper-book.test.js`
- Modify: `src/api/app.js` + `src/run/api.js` — thread a `broker` dep into `portfolioRoutes` following the exact pattern used for `gunvest` (read both files first; `src/run/api.js` constructs it via `createBrokerFromConfig(cfg)`)
- Test: rewrite `test/api/portfolio.test.js`

**Interfaces:**
- Consumes: `repo.listEquitySnapshots`, `repo.listOrderIntents` (Task 1); `broker.isAuthenticated`, `broker.getPositions`, `broker.getAccountSummary` (Task 3); `gunvest.getPrice`, `gunvest.getCandles`.
- Produces GET `/api/portfolio` payload (web consumes in Task 9):

```json
{
  "gateway": { "configured": true, "authenticated": true, "accountId": "DU123456" },
  "stats": { "equity": 100500, "cash": 40000, "totalReturn": 0.005, "spyReturn": 0.003, "qqqReturn": 0.004 },
  "curve": [{ "date": "2026-07-01", "equity": 100200, "spy": 100100, "qqq": 100150 }],
  "positions": [{ "symbol": "AAPL", "qty": 25, "avgCost": 190.1, "markPrice": 195.2, "marketValue": 4880, "unrealizedPnl": 127.5, "unrealizedPnlPct": 0.0268 }],
  "orders": [{ "id": 7, "createdAt": "…", "symbol": "AAPL", "band": "BUY", "conviction": 0.8, "targetWeight": 0.048, "status": "filled", "skipReason": null, "submittedQty": 25, "fillQty": 25, "fillPrice": 190.1, "error": null }]
}
```

**Behavior:**
- Gateway unconfigured (`broker == null`) or unauthenticated → still 200: `gateway.configured/authenticated` false, `positions: []`, `stats` nulls, but `curve` (snapshots) and `orders` (intents) still served — history must not disappear when the gateway blips.
- `curve`: bucket `listEquitySnapshots()` to the LAST snapshot per calendar day. Benchmarks: normalize SPY/QQQ daily closes (existing `gunvest.getCandles('SPY', 400)`) to the first snapshot's equity: `spy[d] = firstEquity * close[d] / closeAtFirstSnapshotDate`. `totalReturn = lastEquity / firstEquity - 1`; `spyReturn`/`qqqReturn` same formula on closes.
- Positions marked with `gunvest.getPrice` (fallback: `markPrice = avgCost`, flag not needed — this is a display route).
- Keep the existing 30s per-user cache pattern from the current file, keyed by intent count + snapshot count.
- This is a global (instance-level) book — drop the per-user watchlist filtering of the old route; auth middleware stays as-is.

- [ ] **Step 1: Write failing route tests** — rewrite `test/api/portfolio.test.js` following the existing supertest-style pattern in that file (fake repo + fake broker + fake gunvest): payload shape with live gateway; gateway-null degraded shape (`configured:false`, curve/orders still present); daily bucketing (two snapshots same day → one curve point); benchmark normalization from first snapshot.
- [ ] **Step 2: Run, verify FAIL**
- [ ] **Step 3: Implement the rewrite; delete `src/portfolio/paper-book.js` + its test; fix any imports** (`grep -r "paper-book" src web test`).
- [ ] **Step 4: Run, verify PASS** — `npx vitest run test/api/portfolio.test.js && npm test`
- [ ] **Step 5: Commit** — `git commit -m "feat!: replace simulated paper book with IBKR-backed portfolio API"` (breaking: `/api/portfolio` payload shape changes).

---

### Task 9: Web — Paper Trading page

**Files:**
- Rewrite: `web/src/pages/PortfolioPage.jsx`
- Modify: `web/src/api/client.js` only if `getPortfolio()` needs a shape change (it's the same GET, likely untouched)
- Test: web test file colocated per existing web test conventions (`ls web/src/pages/*.test.jsx web/test 2>/dev/null` to find them; follow that pattern)

**Interfaces:**
- Consumes: Task 8 payload exactly as documented above. Kill-switch/dry-run toggles need NO new UI — they render automatically in the existing RuntimeSettings page from the Task 2 registry entries (verify by eye).

- [ ] **Step 1: Failing web test** — render page with a mocked `api.getPortfolio` resolving the Task 8 payload; assert: gateway chip text (`Gateway: connected` / `Gateway: down`), equity/return stats, positions table rows, order log rows with status + skip reason. Follow the existing web test file style.
- [ ] **Step 2: Run, verify FAIL** — `cd web && npx vitest run` (or the project's web test script — check `web/package.json`).
- [ ] **Step 3: Rewrite `PortfolioPage.jsx`** — keep the existing structure (Stat cards, recharts LineChart, Card tables, 20s poll). Changes:
  - Header: title "Paper Trading", subtitle "Live IBKR paper account driven by Legion signals".
  - Gateway chip in the header row:

```jsx
function GatewayChip({ gateway }) {
  const ok = gateway?.configured && gateway?.authenticated;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
      {ok ? `Gateway: ${gateway.accountId}` : gateway?.configured ? 'Gateway: down' : 'Gateway: not configured'}
    </span>
  );
}
```

  - Stats row: Equity (`stats.equity`), Cash, Total return, vs SPY, vs QQQ (reuse `signedPct`/`gainColor`).
  - Chart: same recharts block, `curve` keys unchanged (`equity`/`spy`/`qqq`).
  - Positions table: Symbol, Qty, Avg cost → Mark, Market value, Unrealized (`unrealizedPnl` + `unrealizedPnlPct`).
  - Order log table (replaces the trades table): Time, Symbol, Band, Qty, Fill, Status — status cell renders `status` plus `skipReason`/`error` detail:

```jsx
const StatusStyles = {
  filled: 'bg-green-100 text-green-700', submitted: 'bg-blue-100 text-blue-700',
  pending: 'bg-slate-100 text-slate-600', skipped: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
};
function StatusChip({ order }) {
  const detail = order.skipReason ?? order.error;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${StatusStyles[order.status] ?? StatusStyles.pending}`}>
      {order.status}{detail ? ` · ${detail}` : ''}
    </span>
  );
}
```

  - Empty state: no snapshots + no orders → "No paper trades yet — enable trading in Settings."
- [ ] **Step 4: Run web tests + lint, verify PASS** — web vitest + `npm run lint` at repo root.
- [ ] **Step 5: Commit** — `git commit -m "feat: rework portfolio page as the IBKR paper-trading dashboard"`

---

### Task 10: ADR + runbook + docs

**Files:**
- Create: `docs/adr/0035-ibkr-paper-execution.md` (follow the numbering/format of `ls docs/adr`; content: intent outbox rationale, cOID dedupe, IBeam choice, paper-account assertion, signal-driven exits, rollout sequence)
- Create: `docs/RUNBOOK-ibkr-paper-trading.md`: IBKR paper account setup (paper username, reset caveats), `.env.ibeam` creation, first-deploy rollout (deploy → `trading_enabled` on with dry-run → observe order log → `trading_dry_run` off), how to read the order log statuses, kill-switch procedure, what to do when the gateway chip is red (restart ibeam container; `docker logs legion-ibeam`)
- Modify: `docs/ARCHITECTURE.md` — add the executor + IBeam to the component list (match existing prose style)

- [ ] **Step 1: Write the three docs.** No code. Cross-check every env var and runtime key name against Tasks 2/7 (`LEGION_TRADING_ENABLED`, `LEGION_TRADING_DRY_RUN`, `LEGION_TRADING_MIN_NOTIONAL`, `IBKR_GATEWAY_URL`, `LEGION_ALLOW_LIVE_BROKER`, `trading_enabled`, `trading_dry_run`, `trading_min_order_notional`).
- [ ] **Step 2: Full suite + lint** — `npm test && npm run lint`
- [ ] **Step 3: Commit** — `git commit -m "docs: ADR 0035 + runbook for IBKR paper-trading execution"`

---

## Final verification (after all tasks)

- [ ] `npm test` — full backend suite green
- [ ] web tests green
- [ ] `npm run lint` — clean (CI gates on it)
- [ ] `grep -r "paper-book" src web test docs/snapshot-format.md` — no dangling references
- [ ] Push branch, open PR into main (conventional title `feat: execute signals on an IBKR paper account`)
