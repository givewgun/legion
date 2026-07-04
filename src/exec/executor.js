// Executor worker (ADR 0035): drains the order-intent outbox into real DAY
// market orders on the IBKR paper account. Runs inside the emitter process on a
// poll interval. Sequential by design — one intent at a time, so per-symbol
// ordering is inherent and a mid-crash leaves at most one order in flight,
// recoverable via cOID (= intent id) broker-side dedupe.
import { computeSizing } from '../sizing/engine.js';
import { applyRuntimeOverrides } from '../config/runtime-overrides.js';

const DefaultIntervalMs = 15000;
const HoldActions = new Set(['hold']);

export function createExecutor({
  repo,
  broker,
  gunvest,
  cfg,
  logger = console,
  clock: _clock = () => new Date(),
  intervalMs = DefaultIntervalMs,
}) {
  let timer = null;
  let ticking = false;
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
      await repo.updateOrderIntent(intent.id, {
        status: 'skipped',
        skipReason: 'dust',
        targetWeight: sized.targetWeight,
      });
      return;
    }
    if (trading.dryRun) {
      logger.info?.(
        `[executor] dry-run: would ${side} ${qty} ${intent.symbol} (intent ${intent.id}, target ${sized.targetWeight.toFixed(4)})`,
      );
      await repo.updateOrderIntent(intent.id, {
        status: 'skipped',
        skipReason: 'dry-run',
        submittedQty: qty,
        targetWeight: sized.targetWeight,
      });
      return;
    }
    try {
      const { brokerOrderId } = await broker.placeOrder({
        symbol: intent.symbol,
        side,
        qty,
        clientOrderId: String(intent.id),
      });
      await repo.updateOrderIntent(intent.id, {
        status: 'submitted',
        brokerOrderId,
        submittedQty: qty,
        targetWeight: sized.targetWeight,
      });
      logger.info?.(`[executor] submitted ${side} ${qty} ${intent.symbol} (intent ${intent.id}, order ${brokerOrderId})`);
    } catch (err) {
      // Reached the broker and was rejected: terminal — a rejection carries
      // information a human should read. Transport failures upstream stay pending.
      await repo.updateOrderIntent(intent.id, { status: 'failed', error: err.message, targetWeight: sized.targetWeight });
      logger.error(`[executor] order failed for intent ${intent.id} (${intent.symbol}): ${err.message}`);
    }
  }

  // Task 6 replaces this with real fill-tracking against broker.getOrderStatus.
  async function trackSubmitted() {}

  // Task 6 replaces this with hourly equity snapshots during US market hours.
  async function maybeSnapshot() {}

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
