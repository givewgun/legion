import { describe, it, expect } from 'vitest';
import { createExecutor } from '../../src/exec/executor.js';
import { loadConfig } from '../../src/config/index.js';

// Whitelist mirrors src/db/repo.js OrderIntentColumns — the fake repo enforces
// the same "unknown key throws" / "empty patch throws" contract as the real one.
const OrderIntentPatchKeys = [
  'status', 'skipReason', 'brokerOrderId', 'submittedQty',
  'targetWeight', 'fillQty', 'fillPrice', 'error',
];

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const baseCfg = () => loadConfig({}); // trading defaults: enabled=false, dryRun=true, minOrderNotional=50, baseWeight=.05, maxPerName=.10

const mkIntent = (over = {}) => ({
  id: 1, signalId: 9, symbol: 'AAPL', band: 'BUY', conviction: 1, qualityMult: 1, status: 'pending', ...over,
});

// In-memory fake repo backed by an array of intent rows, mimicking src/db/repo.js's
// order-intent methods (including its patch whitelist and created_at-ASC ordering).
function makeRepo(intents, runtimeConfig = {}) {
  return {
    intents,
    runtimeConfig,
    equitySnapshots: [],
    async getRuntimeConfig() {
      return this.runtimeConfig;
    },
    async listOrderIntentsByStatus(status) {
      return this.intents.filter((i) => i.status === status).sort((a, b) => a.id - b.id);
    },
    async updateOrderIntent(id, patch) {
      const keys = Object.keys(patch);
      if (keys.length === 0) throw new Error('updateOrderIntent: empty patch');
      for (const k of keys) {
        if (!OrderIntentPatchKeys.includes(k)) throw new Error(`updateOrderIntent: unknown key ${k}`);
      }
      const intent = this.intents.find((i) => i.id === id);
      Object.assign(intent, patch);
    },
    async addEquitySnapshot({ equity, cash }) {
      this.equitySnapshots.push({ equity, cash });
    },
  };
}

// Fake broker recording every call (optionally into a shared `log` for ordering
// assertions) and returning a fixed account/position snapshot. `orderStatusByCoid`
// maps clientOrderId (string) -> getOrderStatus response; `getOrderStatusImpl`
// overrides the lookup entirely (e.g. to throw).
function makeBroker({
  equity = 100000,
  cash = 100000,
  positions = [],
  placeOrderImpl,
  orderStatusByCoid = {},
  getOrderStatusImpl,
  log,
} = {}) {
  const calls = { getAccountSummary: 0, getPositions: 0, placeOrder: [], getOrderStatus: [] };
  return {
    calls,
    orderStatusByCoid,
    async getAccountSummary() {
      calls.getAccountSummary += 1;
      log?.push('getAccountSummary');
      return { accountId: 'DU1', equity, cash };
    },
    async getPositions() {
      calls.getPositions += 1;
      log?.push('getPositions');
      return positions;
    },
    async placeOrder(order) {
      calls.placeOrder.push(order);
      log?.push(`placeOrder:${order.symbol}`);
      if (placeOrderImpl) return placeOrderImpl(order);
      return { brokerOrderId: `B-${calls.placeOrder.length}` };
    },
    async getOrderStatus(clientOrderId) {
      calls.getOrderStatus.push(clientOrderId);
      log?.push(`getOrderStatus:${clientOrderId}`);
      if (getOrderStatusImpl) return getOrderStatusImpl(clientOrderId);
      return this.orderStatusByCoid[clientOrderId] ?? { found: false };
    },
  };
}

// Fake gunvest price client with fixed prices per symbol.
function makeGunvest(prices, log) {
  return {
    async getPrice(symbol) {
      log?.push(`getPrice:${symbol}`);
      if (!(symbol in prices)) throw new Error(`no price for ${symbol}`);
      return { price: prices[symbol] };
    },
  };
}

describe('executor', () => {
  it('kill switch off: pending intents untouched', async () => {
    const intent = mkIntent();
    const repo = makeRepo([intent]); // no runtime override -> cfg default trading.enabled=false
    const broker = makeBroker({ positions: [] });
    const gunvest = makeGunvest({ AAPL: 200 });
    // Off-hours clock: isolates this from the equity snapshot, which (per finding
    // MINOR-d) now runs regardless of the kill switch -- pin outside market hours
    // so the only thing under test here is the pending-intents/kill-switch gate.
    const now = new Date('2026-07-04T12:00:00-04:00'); // Saturday
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger, clock: () => now });

    await executor.tick();

    expect(intent.status).toBe('pending');
    expect(broker.calls.getAccountSummary).toBe(0);
    expect(broker.calls.getPositions).toBe(0);
    expect(broker.calls.placeOrder).toHaveLength(0);
  });

  it('dry-run: sizes, marks skipped(dry-run) with would-be qty', async () => {
    const intent = mkIntent({ id: 1 });
    const repo = makeRepo([intent], { trading_enabled: 'true' }); // dryRun stays default (true)
    const broker = makeBroker({ equity: 100000, positions: [] });
    const gunvest = makeGunvest({ AAPL: 200 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    expect(intent.status).toBe('skipped');
    expect(intent.skipReason).toBe('dry-run');
    // equity 100000 * conviction 1 * qualityMult 1 * baseWeight .05 / price 200 = 25
    expect(intent.submittedQty).toBe(25);
    expect(intent.targetWeight).toBeCloseTo(0.05, 5);
    expect(broker.calls.placeOrder).toHaveLength(0);
  });

  it('BUY intent submits rounded qty with cOID = intent id', async () => {
    const intent = mkIntent({ id: 1 });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({ equity: 100000, positions: [] });
    const gunvest = makeGunvest({ AAPL: 200 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    // equity 100000, price 200, conviction 1, qualityMult 1, baseWeight .05 -> target 5000 -> 25 shares
    expect(broker.calls.placeOrder).toEqual([{ symbol: 'AAPL', side: 'BUY', qty: 25, clientOrderId: '1' }]);
    expect(intent.status).toBe('submitted');
    expect(intent.brokerOrderId).toBe('B-1');
    expect(intent.submittedQty).toBe(25);
    expect(intent.targetWeight).toBeCloseTo(0.05, 5);
  });

  it('SELL/NO_CONSENSUS: closes actual position, qty capped at held shares', async () => {
    const intent = mkIntent({ id: 2, band: 'NO_CONSENSUS' });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({
      equity: 100000,
      positions: [{ symbol: 'AAPL', qty: 30, avgCost: 150, conid: 1 }],
    });
    const gunvest = makeGunvest({ AAPL: 200 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    expect(broker.calls.placeOrder).toEqual([{ symbol: 'AAPL', side: 'SELL', qty: 30, clientOrderId: '2' }]);
    expect(intent.status).toBe('submitted');
    expect(intent.submittedQty).toBe(30);
    expect(intent.targetWeight).toBe(0);
  });

  it('SELL cap binds: fractional held qty is floored so we never submit a fractional or over-sized order', async () => {
    const heldQty = 29.6; // deltaShares -29.6 -> Math.round -> 30 > held; floor(29.6)=29 caps it to whole shares
    const intent = mkIntent({ id: 8, band: 'NO_CONSENSUS' });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({
      equity: 100000,
      positions: [{ symbol: 'AAPL', qty: heldQty, avgCost: 150, conid: 1 }],
    });
    const gunvest = makeGunvest({ AAPL: 200 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    expect(broker.calls.placeOrder).toEqual([{ symbol: 'AAPL', side: 'SELL', qty: 29, clientOrderId: '8' }]);
    expect(intent.status).toBe('submitted');
    expect(intent.submittedQty).toBe(29);
  });

  it('dust: |deltaUSD| below minOrderNotional → skipped(dust)', async () => {
    const intent = mkIntent({ id: 3, conviction: 0.6 });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({ equity: 1000, positions: [] });
    const gunvest = makeGunvest({ AAPL: 10 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    // targetWeight .05*.6=.03 -> deltaUSD 30; rebalance band (.01*1000=10) is cleared
    // so this is NOT a 'hold' -- it's specifically the minOrderNotional (50) dust gate.
    expect(intent.status).toBe('skipped');
    expect(intent.skipReason).toBe('dust');
    expect(broker.calls.placeOrder).toHaveLength(0);
  });

  it('hold inside rebalance band → skipped(dust)', async () => {
    const intent = mkIntent({ id: 4 });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({
      equity: 10000,
      positions: [{ symbol: 'AAPL', qty: 5, avgCost: 100 }],
    });
    const gunvest = makeGunvest({ AAPL: 100 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    // currentWeight 500/10000=.05 equals targetWeight .05*1*1 -> deltaUSD 0 -> action 'hold'
    expect(intent.status).toBe('skipped');
    expect(intent.skipReason).toBe('dust');
    expect(broker.calls.placeOrder).toHaveLength(0);
  });

  it('equity fetch failure: intent stays pending, no order', async () => {
    const intent = mkIntent({ id: 5 });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({ equity: 100000, positions: [] });
    broker.getAccountSummary = async () => {
      throw new Error('gateway timeout');
    };
    const gunvest = makeGunvest({ AAPL: 200 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    expect(intent.status).toBe('pending');
    expect(intent.targetWeight).toBeUndefined();
    expect(broker.calls.placeOrder).toHaveLength(0);
  });

  it('placeOrder rejection → failed with error text', async () => {
    const intent = mkIntent({ id: 6 });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({
      equity: 100000,
      positions: [],
      placeOrderImpl: () => {
        throw new Error('Order rejected: insufficient buying power');
      },
    });
    const gunvest = makeGunvest({ AAPL: 200 });
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    expect(intent.status).toBe('failed');
    expect(intent.error).toBe('Order rejected: insufficient buying power');
    expect(intent.targetWeight).toBeCloseTo(0.05, 5);
  });

  it('submitted-write failure: real order is never mislabeled failed; error logged', async () => {
    const intent = mkIntent({ id: 7 });
    const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
    // placeOrder succeeds, but persisting status:'submitted' throws once — the
    // order IS live at the broker, so the intent must NOT be marked failed.
    const realUpdate = repo.updateOrderIntent.bind(repo);
    let persistFailures = 0;
    repo.updateOrderIntent = async (id, patch) => {
      if (patch.status === 'submitted' && persistFailures === 0) {
        persistFailures += 1;
        throw new Error('db connection lost');
      }
      return realUpdate(id, patch);
    };
    const broker = makeBroker({ equity: 100000, positions: [] });
    const gunvest = makeGunvest({ AAPL: 200 });
    const errors = [];
    const logger = { ...silentLogger, error: (msg) => errors.push(msg) };
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger });

    await executor.tick();

    expect(broker.calls.placeOrder).toHaveLength(1);
    expect(persistFailures).toBe(1);
    expect(intent.status).toBe('pending'); // untouched — NOT 'failed'
    expect(intent.error).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('B-1'); // broker order id
    expect(errors[0]).toContain('intent 7');

    // Next tick retries the still-pending intent with the SAME cOID — the broker
    // dedupes on cOID so this cannot double-order — and the write now succeeds.
    await executor.tick();
    expect(broker.calls.placeOrder).toHaveLength(2);
    expect(broker.calls.placeOrder[1].clientOrderId).toBe('7');
    expect(intent.status).toBe('submitted');
  });

  it('processes intents oldest-first, sequentially', async () => {
    const log = [];
    const older = mkIntent({ id: 1, symbol: 'AAPL' });
    const newer = mkIntent({ id: 2, symbol: 'MSFT' });
    // Stored newest-first to prove ordering comes from the repo's created_at-ASC
    // contract (sorted by id here), not from insertion order in the backing array.
    const repo = makeRepo([newer, older], { trading_enabled: 'true', trading_dry_run: 'false' });
    const broker = makeBroker({ equity: 100000, positions: [], log });
    const gunvest = makeGunvest({ AAPL: 200, MSFT: 100 }, log);
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

    await executor.tick();

    // Every fetch+submit for AAPL (the older intent) completes before MSFT's
    // fetches even start -- no interleaving across intents. Each intent now opens
    // with a Task 6 crash-recovery probe (getOrderStatus) before the sizing fetch.
    expect(log).toEqual([
      'getOrderStatus:1', 'getAccountSummary', 'getPositions', 'getPrice:AAPL', 'placeOrder:AAPL',
      'getOrderStatus:2', 'getAccountSummary', 'getPositions', 'getPrice:MSFT', 'placeOrder:MSFT',
    ]);
    expect(older.status).toBe('submitted');
    expect(newer.status).toBe('submitted');
  });

  describe('fill tracking (submitted intents)', () => {
    it('submitted intent fills: records fill qty/price, snapshots equity', async () => {
      const intent = mkIntent({ id: 10, status: 'submitted', brokerOrderId: 'B-1' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 10: { found: true, status: 'filled', fillQty: 25, avgFillPrice: 198.4 } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      // Off-hours clock isolates the fill-triggered snapshot from the hourly gate.
      const now = new Date('2026-07-02T22:00:00-04:00');
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger, clock: () => now });

      await executor.tick();

      expect(intent.status).toBe('filled');
      expect(intent.fillQty).toBe(25);
      expect(intent.fillPrice).toBe(198.4);
      expect(repo.equitySnapshots).toEqual([{ equity: 100000, cash: 100000 }]);
    });

    it('submitted intent still resting: left submitted (overnight order)', async () => {
      const intent = mkIntent({ id: 11, status: 'submitted', brokerOrderId: 'B-2' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 11: { found: true, status: 'submitted' } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('submitted');
      expect(intent.fillQty).toBeUndefined();
      expect(broker.calls.placeOrder).toHaveLength(0);
    });

    it('submitted intent cancelled/expired: marked failed with reason', async () => {
      const intent = mkIntent({ id: 12, status: 'submitted', brokerOrderId: 'B-3' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 12: { found: true, status: 'cancelled' } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('failed');
      expect(intent.error).toBe('order cancelled/expired unfilled');
    });

    it('crash recovery: submitted intent whose cOID is unknown to broker → failed(order lost)', async () => {
      // Also covers finding 5's fallback: band 'BUY' (BAND_LONG) with no position at
      // the broker is NOT consistent with a fill, so the day-scope cross-check must
      // fall through to the pre-existing failed path rather than mislabeling it filled.
      const intent = mkIntent({ id: 13, status: 'submitted', brokerOrderId: 'B-4' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({ equity: 100000, positions: [] }); // no orderStatusByCoid entry -> found:false
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('failed');
      expect(intent.error).toBe('order not found at broker (lost after submit)');
    });

    it('day-scoped orders endpoint: not-found but position present is consistent with a BUY fill → filled, price unknown', async () => {
      const intent = mkIntent({ id: 16, status: 'submitted', brokerOrderId: 'B-7', submittedQty: 25, band: 'BUY' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [{ symbol: 'AAPL', qty: 25, avgCost: 200 }], // present -> consistent with a filled BUY
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const warnings = [];
      const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger });

      await executor.tick();

      expect(intent.status).toBe('filled');
      expect(intent.fillQty).toBe(25);
      expect(intent.fillPrice).toBeNull();
      expect(warnings.some((w) => w.includes('day-scoped'))).toBe(true);
    });

    it('submitted intent cancelled after a partial fill: failed, but the partial fillQty/fillPrice are recorded', async () => {
      const intent = mkIntent({ id: 17, status: 'submitted', brokerOrderId: 'B-8' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 17: { found: true, status: 'cancelled', fillQty: 10, avgFillPrice: 199.5 } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('failed');
      expect(intent.error).toBe('order cancelled/expired unfilled');
      expect(intent.fillQty).toBe(10);
      expect(intent.fillPrice).toBe(199.5);
    });

    it('trackSubmitted: getOrderStatus throw logs warning and leaves intent submitted for retry', async () => {
      const intent = mkIntent({ id: 14, status: 'submitted', brokerOrderId: 'B-5' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        getOrderStatusImpl: () => {
          throw new Error('gateway timeout');
        },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const warnings = [];
      const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger });

      await executor.tick();

      expect(intent.status).toBe('submitted'); // left untouched -- retried next tick
      expect(warnings.some((w) => w.includes('order status check failed'))).toBe(true);
    });
  });

  describe('crash recovery of pending intents (persist-failure hole)', () => {
    it('pending intent with a live submitted order at broker: no resubmit, marked submitted', async () => {
      const intent = mkIntent({ id: 20, status: 'pending' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 20: { found: true, status: 'submitted' } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(broker.calls.placeOrder).toHaveLength(0);
      expect(intent.status).toBe('submitted');
    });

    it('pending intent with a filled order at broker: marked filled + equity snapshot, no resubmit', async () => {
      const intent = mkIntent({ id: 21, status: 'pending' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 21: { found: true, status: 'filled', fillQty: 10, avgFillPrice: 201.5 } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const now = new Date('2026-07-02T22:00:00-04:00'); // off-hours: isolates the fill-triggered snapshot
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger, clock: () => now });

      await executor.tick();

      expect(broker.calls.placeOrder).toHaveLength(0);
      expect(intent.status).toBe('filled');
      expect(intent.fillQty).toBe(10);
      expect(intent.fillPrice).toBe(201.5);
      expect(repo.equitySnapshots).toEqual([{ equity: 100000, cash: 100000 }]);
    });

    it('pending intent with a cancelled order at broker: marked failed with reason, no resubmit', async () => {
      const intent = mkIntent({ id: 23, status: 'pending' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 23: { found: true, status: 'cancelled' } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(broker.calls.placeOrder).toHaveLength(0);
      expect(intent.status).toBe('failed');
      expect(intent.error).toBe('order cancelled/expired unfilled');
    });

    it('pending intent probe throws: gateway down, held (not resubmitted) to avoid a duplicate-cOID mislabel', async () => {
      const intent = mkIntent({ id: 22, status: 'pending' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        getOrderStatusImpl: () => {
          throw new Error('gateway timeout');
        },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const warnings = [];
      const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger });

      await executor.tick();

      expect(broker.calls.placeOrder).toHaveLength(0);
      expect(intent.status).toBe('pending');
      expect(warnings.some((w) => w.includes('order status probe failed'))).toBe(true);
    });

    it('reconciled to submitted backfills submittedQty from the probe when the probe provides one', async () => {
      const intent = mkIntent({ id: 24, status: 'pending' });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 24: { found: true, status: 'submitted', fillQty: 12 } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(broker.calls.placeOrder).toHaveLength(0);
      expect(intent.status).toBe('submitted');
      expect(intent.submittedQty).toBe(12);
    });
  });

  describe('placeOrder throw does not always mean rejection (Task 3)', () => {
    it('placeOrder throws but a follow-up probe finds the order live: marked submitted, not failed', async () => {
      const intent = mkIntent({ id: 60 });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      let probeCalls = 0;
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        placeOrderImpl: () => {
          throw new Error('socket hang up');
        },
        getOrderStatusImpl: () => {
          probeCalls += 1;
          // 1st call: the pre-sizing reconcile probe -- nothing live yet.
          // 2nd call: the post-placeOrder-throw probe -- the order actually went through.
          return probeCalls === 1 ? { found: false } : { found: true, status: 'submitted' };
        },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('submitted');
      expect(intent.error).toBeUndefined();
      expect(intent.submittedQty).toBe(25);
      expect(intent.brokerOrderId).toBeNull();
    });

    it('placeOrder throws and the follow-up probe also throws (gateway down): stays pending, warns', async () => {
      const intent = mkIntent({ id: 61 });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      let probeCalls = 0;
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        placeOrderImpl: () => {
          throw new Error('socket hang up');
        },
        getOrderStatusImpl: () => {
          probeCalls += 1;
          if (probeCalls === 1) return { found: false }; // pre-sizing reconcile: nothing live yet
          throw new Error('gateway timeout'); // post-placeOrder-throw probe: can't tell
        },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const warnings = [];
      const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger });

      await executor.tick();

      expect(intent.status).toBe('pending');
      expect(intent.error).toBeUndefined();
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('placeOrder throws and the follow-up probe confirms not-found: genuine rejection, marked failed', async () => {
      // Same setup as the plain rejection test -- the fake broker's default
      // getOrderStatus (no orderStatusByCoid entry) returns found:false, proving the
      // probe-first catch path still lands on 'failed' for a true rejection.
      const intent = mkIntent({ id: 62 });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        placeOrderImpl: () => {
          throw new Error('Order rejected: insufficient buying power');
        },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('failed');
      expect(intent.error).toBe('Order rejected: insufficient buying power');
    });
  });

  describe('HOLD band never liquidates (Task 2)', () => {
    it('HOLD intent with a held position: no order, skipped(hold)', async () => {
      const intent = mkIntent({ id: 50, band: 'HOLD', conviction: 0 });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [{ symbol: 'AAPL', qty: 25, avgCost: 150 }],
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('skipped');
      expect(intent.skipReason).toBe('hold');
      expect(broker.calls.placeOrder).toHaveLength(0);
      expect(broker.calls.getPositions).toBe(0); // short-circuits before the sizing fetch
    });

    it('HOLD intent with no position: skipped(hold), no orders', async () => {
      const intent = mkIntent({ id: 51, band: 'HOLD', conviction: 0 });
      const repo = makeRepo([intent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({ equity: 100000, positions: [] });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(intent.status).toBe('skipped');
      expect(intent.skipReason).toBe('hold');
      expect(broker.calls.placeOrder).toHaveLength(0);
    });
  });

  describe('supersede + defer same-symbol pending backlog (Task 1)', () => {
    it('backlog of 3 same-symbol pendings: only the newest is processed, the older two are skipped(superseded)', async () => {
      const oldest = mkIntent({ id: 30, symbol: 'AAPL' });
      const middle = mkIntent({ id: 31, symbol: 'AAPL' });
      const newest = mkIntent({ id: 32, symbol: 'AAPL' });
      const repo = makeRepo([oldest, middle, newest], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({ equity: 100000, positions: [] });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(oldest.status).toBe('skipped');
      expect(oldest.skipReason).toBe('superseded');
      expect(middle.status).toBe('skipped');
      expect(middle.skipReason).toBe('superseded');
      expect(newest.status).toBe('submitted');
      expect(broker.calls.placeOrder).toEqual([{ symbol: 'AAPL', side: 'BUY', qty: 25, clientOrderId: '32' }]);
    });

    it('pending intent is deferred while a same-symbol submitted order is unfilled; processed once it resolves', async () => {
      const submittedIntent = mkIntent({ id: 40, symbol: 'AAPL', status: 'submitted', brokerOrderId: 'B-40' });
      const pendingIntent = mkIntent({ id: 41, symbol: 'AAPL' });
      const repo = makeRepo([submittedIntent, pendingIntent], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({
        equity: 100000,
        positions: [],
        orderStatusByCoid: { 40: { found: true, status: 'submitted' } },
      });
      const gunvest = makeGunvest({ AAPL: 200 });
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

      await executor.tick();

      expect(pendingIntent.status).toBe('pending'); // untouched -- deferred behind the in-flight order
      expect(broker.calls.placeOrder).toHaveLength(0);

      // Next tick: the submitted order fills, freeing the symbol for the deferred intent.
      broker.orderStatusByCoid[40] = { found: true, status: 'filled', fillQty: 25, avgFillPrice: 200 };
      await executor.tick();

      expect(submittedIntent.status).toBe('filled');
      expect(pendingIntent.status).toBe('submitted');
      expect(broker.calls.placeOrder).toEqual([{ symbol: 'AAPL', side: 'BUY', qty: 25, clientOrderId: '41' }]);
    });
  });

  describe('equity snapshots', () => {
    it('hourly in-market snapshot: taken when >1h since last and market open; skipped off-hours', async () => {
      const repo = makeRepo([], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({ equity: 100000, positions: [] });
      const gunvest = makeGunvest({});
      let now = new Date('2026-07-02T12:00:00-04:00'); // Thursday, market open
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger, clock: () => now });

      await executor.tick(); // first tick ever: lastSnapshotMs starts at 0 -> snapshot taken
      expect(repo.equitySnapshots).toHaveLength(1);

      await executor.tick(); // immediately again: <1h since last -> gated, no new snapshot
      expect(repo.equitySnapshots).toHaveLength(1);

      now = new Date(now.getTime() + 61 * 60 * 1000); // advance >1h, still inside market hours
      await executor.tick();
      expect(repo.equitySnapshots).toHaveLength(2);

      now = new Date('2026-07-02T22:00:00-04:00'); // same day, after close
      await executor.tick();
      expect(repo.equitySnapshots).toHaveLength(2); // off-hours: skipped despite >1h gap

      now = new Date('2026-07-04T12:00:00-04:00'); // Saturday, weekend
      await executor.tick();
      expect(repo.equitySnapshots).toHaveLength(2); // weekend: skipped
    });

    it('snapshot still runs when trading is disabled: the equity curve must not gap while the kill switch is off', async () => {
      const repo = makeRepo([], {}); // trading_enabled defaults false
      const broker = makeBroker({ equity: 100000, positions: [] });
      const gunvest = makeGunvest({});
      const now = new Date('2026-07-02T12:00:00-04:00'); // Thursday, market open
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger, clock: () => now });

      await executor.tick();

      expect(repo.equitySnapshots).toHaveLength(1);
      expect(broker.calls.placeOrder).toHaveLength(0); // trading still disabled -- no orders
    });

    it('snapshot failure logs but does not fail the tick', async () => {
      const repo = makeRepo([], { trading_enabled: 'true', trading_dry_run: 'false' });
      const broker = makeBroker({ equity: 100000, positions: [] });
      broker.getAccountSummary = async () => {
        throw new Error('gateway timeout');
      };
      const gunvest = makeGunvest({});
      const warnings = [];
      const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
      const now = new Date('2026-07-02T15:00:00-04:00'); // market open
      const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger, clock: () => now });

      await expect(executor.tick()).resolves.toBeUndefined();

      expect(repo.equitySnapshots).toHaveLength(0);
      expect(warnings.some((w) => w.includes('equity snapshot failed'))).toBe(true);
    });
  });
});
