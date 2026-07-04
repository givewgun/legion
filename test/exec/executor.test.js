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
  };
}

// Fake broker recording every call (optionally into a shared `log` for ordering
// assertions) and returning a fixed account/position snapshot.
function makeBroker({ equity = 100000, cash = 100000, positions = [], placeOrderImpl, log } = {}) {
  const calls = { getAccountSummary: 0, getPositions: 0, placeOrder: [] };
  return {
    calls,
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
    const executor = createExecutor({ repo, broker, gunvest, cfg: baseCfg(), logger: silentLogger });

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
    // fetches even start -- no interleaving across intents.
    expect(log).toEqual([
      'getAccountSummary', 'getPositions', 'getPrice:AAPL', 'placeOrder:AAPL',
      'getAccountSummary', 'getPositions', 'getPrice:MSFT', 'placeOrder:MSFT',
    ]);
    expect(older.status).toBe('submitted');
    expect(newer.status).toBe('submitted');
  });
});
