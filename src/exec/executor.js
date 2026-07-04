// Executor worker (ADR 0035): drains the order-intent outbox into real DAY
// market orders on the IBKR paper account. Runs inside the emitter process on a
// poll interval. Sequential by design — one intent at a time, so per-symbol
// ordering is inherent and a mid-crash leaves at most one order in flight,
// recoverable via cOID (= intent id) broker-side dedupe.
import { computeSizing } from '../sizing/engine.js';
import { applyRuntimeOverrides } from '../config/runtime-overrides.js';

const DefaultIntervalMs = 15000;
const HoldActions = new Set(['hold']);
// Equity snapshots are taken at most this often, gated to US regular market hours.
const SnapshotEveryMs = 60 * 60 * 1000;

export function createExecutor({
  repo,
  broker,
  gunvest,
  cfg,
  logger = console,
  clock = () => new Date(),
  intervalMs = DefaultIntervalMs,
}) {
  let timer = null;
  let ticking = false;
  let lastEnabled = null;
  let lastSnapshotMs = 0;

  async function tradingCfg() {
    const overrides = await repo.getRuntimeConfig();
    return applyRuntimeOverrides(cfg, overrides, { warn: logger.warn?.bind(logger) ?? (() => {}) }).trading;
  }

  // Guards the persist-failure hole: a pending intent may already have a live
  // order at the broker under cOID = intent id, if a prior tick's placeOrder
  // succeeded but the follow-up DB write (marking it 'submitted') then failed.
  // A blind resubmit would hit a duplicate-cOID rejection at the broker. Probe
  // first and reconcile instead of resubmitting whenever the broker already
  // knows about this cOID.
  async function reconcilePendingAtBroker(intent) {
    let probe;
    try {
      probe = await broker.getOrderStatus(String(intent.id));
    } catch (err) {
      logger.warn?.(`[executor] order status probe failed for intent ${intent.id}; proceeding with submission: ${err.message}`);
      return false;
    }
    if (!probe.found) return false;
    if (probe.status === 'filled') {
      await repo.updateOrderIntent(intent.id, { status: 'filled', fillQty: probe.fillQty, fillPrice: probe.avgFillPrice });
      logger.info?.(`[executor] recovered pending intent ${intent.id}: already filled ${probe.fillQty} ${intent.symbol} @ ${probe.avgFillPrice}`);
      await snapshotEquity();
    } else if (probe.status === 'submitted') {
      await repo.updateOrderIntent(intent.id, { status: 'submitted' });
      logger.info?.(`[executor] recovered pending intent ${intent.id}: already submitted at broker`);
    } else if (probe.status === 'cancelled') {
      await repo.updateOrderIntent(intent.id, { status: 'failed', error: 'order cancelled/expired unfilled' });
    }
    return true;
  }

  async function processPending(intent, trading) {
    if (await reconcilePendingAtBroker(intent)) return;

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
    let brokerOrderId;
    try {
      ({ brokerOrderId } = await broker.placeOrder({
        symbol: intent.symbol,
        side,
        qty,
        clientOrderId: String(intent.id),
      }));
    } catch (err) {
      // Reached the broker and was rejected: terminal — a rejection carries
      // information a human should read. Transport failures upstream stay pending.
      await repo.updateOrderIntent(intent.id, { status: 'failed', error: err.message, targetWeight: sized.targetWeight });
      logger.error?.(`[executor] order failed for intent ${intent.id} (${intent.symbol}): ${err.message}`);
      return;
    }
    try {
      await repo.updateOrderIntent(intent.id, {
        status: 'submitted',
        brokerOrderId,
        submittedQty: qty,
        targetWeight: sized.targetWeight,
      });
      logger.info?.(`[executor] submitted ${side} ${qty} ${intent.symbol} (intent ${intent.id}, order ${brokerOrderId})`);
    } catch (err) {
      // The order IS live at the broker — never mark it failed over a DB write.
      // Leave the intent as-is (pending); next tick re-submits with the same cOID
      // (= intent id), which the broker dedupes, so no double order — and Task 6's
      // fill tracking reconciles the true state.
      logger.error?.(
        `[executor] CRITICAL: order ${brokerOrderId} submitted for intent ${intent.id} (${intent.symbol}) but persisting 'submitted' failed: ${err.message} — leaving intent pending for cOID-deduped reconcile`,
      );
    }
  }

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

  async function tick() {
    const trading = await tradingCfg();
    if (trading.enabled !== lastEnabled) {
      logger.info?.(`[executor] trading ${trading.enabled ? 'ENABLED' : 'disabled'}${trading.dryRun ? ' (dry-run)' : ''}`);
      lastEnabled = trading.enabled;
    }
    if (!trading.enabled) return;

    await trackSubmitted();
    for (const intent of await repo.listOrderIntentsByStatus('pending')) {
      await processPending(intent, trading);
    }
    await maybeSnapshot();
  }

  async function guardedTick() {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
      await tick();
    } catch (err) {
      logger.error?.(`[executor] tick failed: ${err.message}`);
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
