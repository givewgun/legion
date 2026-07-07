// Executor worker (ADR 0035): drains the order-intent outbox into real DAY
// market orders on the active broker connection (IBKR or Webull — ADR 0036).
// Runs inside the emitter process on a poll interval. Sequential by design — one intent at a time, so per-symbol
// ordering is inherent and a mid-crash leaves at most one order in flight,
// recoverable via cOID (= intent id) broker-side dedupe.
import { computeSizing, BAND_LONG } from '../sizing/engine.js';
import { applyRuntimeOverrides } from '../config/runtime-overrides.js';

const DefaultIntervalMs = 15000;
const HoldActions = new Set(['hold']);
// Equity snapshots are taken at most this often, gated to US regular market hours.
const SnapshotEveryMs = 60 * 60 * 1000;

export function createExecutor({
  repo,
  brokers,
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
  let lastBrokerKey = null;
  // Resolved at the top of each tick from the active broker connection (ADR
  // 0036) — a dashboard switch takes effect next tick, no restart. All helpers
  // below read this tick-scoped instance.
  let broker = null;

  async function tradingCfg() {
    const overrides = await repo.getRuntimeConfig();
    return applyRuntimeOverrides(cfg, overrides, { warn: logger.warn?.bind(logger) ?? (() => {}) }).trading;
  }

  // A cancelled/expired order sometimes carries a nonzero partial fill (the resting
  // qty was cancelled, not the whole order) -- record it instead of discarding it.
  function cancelledPatch(status) {
    const patch = { status: 'failed', error: 'order cancelled/expired unfilled' };
    if (status.fillQty) {
      patch.fillQty = status.fillQty;
      patch.fillPrice = status.avgFillPrice;
    }
    return patch;
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
      // Gateway flaky: we cannot tell whether a prior tick's placeOrder actually
      // reached the broker. Resubmitting on a guess risks a live order getting
      // mislabeled failed via a duplicate-cOID rejection -- hold instead of
      // proceeding to submission.
      logger.warn?.(`[executor] order status probe failed for intent ${intent.id}; holding (not resubmitting): ${err.message}`);
      return true;
    }
    if (!probe.found) return false;
    if (probe.status === 'filled') {
      await repo.updateOrderIntent(intent.id, { status: 'filled', fillQty: probe.fillQty, fillPrice: probe.avgFillPrice });
      logger.info?.(`[executor] recovered pending intent ${intent.id}: already filled ${probe.fillQty} ${intent.symbol} @ ${probe.avgFillPrice}`);
      await snapshotEquity();
    } else if (probe.status === 'submitted') {
      // Qty is otherwise unknown for a pending intent recovered this way -- the
      // adapter always returns a numeric fillQty (0 for a resting order), so a
      // nonzero fill-so-far is the only qty signal worth storing; else null.
      await repo.updateOrderIntent(intent.id, {
        status: 'submitted',
        submittedQty: probe.fillQty || null,
      });
      logger.info?.(`[executor] recovered pending intent ${intent.id}: already submitted at broker`);
    } else if (probe.status === 'cancelled') {
      await repo.updateOrderIntent(intent.id, cancelledPatch(probe));
    }
    return true;
  }

  async function processPending(intent, trading) {
    // HOLD (a genuine consensus hold, or risk's blockBuy downgrade) is a no-action
    // band -- computeSizing would otherwise size it as a target weight of zero
    // (same as SELL/NO_CONSENSUS) and generate a closing order. Only SELL/
    // STRONG_SELL/NO_CONSENSUS close a position; HOLD must never liquidate.
    // Checked before the reconcile probe: a HOLD intent can never have placed
    // an order, so probing would waste a call and leave HOLDs pending whenever
    // the gateway is down.
    if (intent.band === 'HOLD') {
      await repo.updateOrderIntent(intent.id, { status: 'skipped', skipReason: 'hold' });
      return;
    }

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
    // Whole shares only: floor the held qty (never sell a fraction of a share).
    if (side === 'SELL' && held) qty = Math.min(qty, Math.floor(held.qty));

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
      // A placeOrder throw is not always a rejection -- e.g. a response timeout
      // after the broker already accepted the order. Probe before concluding it
      // failed, the same cOID-dedupe-aware discipline as reconcilePendingAtBroker.
      let probe;
      try {
        probe = await broker.getOrderStatus(String(intent.id));
      } catch (probeErr) {
        // Can't tell whether the order reached the broker before the transport
        // failure -- do not guess. Stay pending; the next tick's reconcile probe
        // resolves the true state.
        logger.warn?.(
          `[executor] placeOrder failed for intent ${intent.id} (${intent.symbol}) and the follow-up order-status probe also failed; leaving pending: placeOrder error: ${err.message}; probe error: ${probeErr.message}`,
        );
        return;
      }
      if (probe.found) {
        // The order IS live at the broker despite placeOrder throwing -- never
        // mark a live order failed.
        await repo.updateOrderIntent(intent.id, {
          status: 'submitted',
          brokerOrderId: probe.brokerOrderId ?? null,
          submittedQty: qty,
          targetWeight: sized.targetWeight,
        });
        logger.info?.(
          `[executor] placeOrder threw for intent ${intent.id} (${intent.symbol}) but the order is live at the broker; marked submitted: ${err.message}`,
        );
        return;
      }
      // Reached the broker and was genuinely rejected: terminal — a rejection
      // carries information a human should read. Transport failures upstream stay pending.
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
  // IBKR's orders endpoint is day-scoped: a cOID that filled and cleared earlier
  // the same session can legitimately return not-found without the order having
  // been "lost". Before concluding that, cross-check the account's actual position
  // against the direction we submitted — kept deliberately simple: present for a
  // BUY, absent for a SELL/closing intent is "consistent with a fill".
  async function wasProbablyFilledDespiteNotFound(intent) {
    const positions = await broker.getPositions().catch((err) => {
      logger.warn?.(`[executor] position cross-check failed for intent ${intent.id}: ${err.message}`);
      return null;
    });
    if (!positions) return false; // can't confirm -- keep the conservative failed path
    const held = positions.find((p) => p.symbol === intent.symbol);
    return BAND_LONG.has(intent.band) ? !!held : !held;
  }

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
        if (await wasProbablyFilledDespiteNotFound(intent)) {
          await repo.updateOrderIntent(intent.id, { status: 'filled', fillQty: intent.submittedQty ?? null, fillPrice: null });
          logger.warn?.(
            `[executor] intent ${intent.id} (${intent.symbol}) not found on the day-scoped orders endpoint, but the account position is consistent with a fill; marking filled without a fill price (lost to day-scope)`,
          );
        } else {
          await repo.updateOrderIntent(intent.id, { status: 'failed', error: 'order not found at broker (lost after submit)' });
        }
        continue;
      }
      if (st.status === 'filled') {
        await repo.updateOrderIntent(intent.id, { status: 'filled', fillQty: st.fillQty, fillPrice: st.avgFillPrice });
        logger.info?.(`[executor] filled intent ${intent.id}: ${st.fillQty} ${intent.symbol} @ ${st.avgFillPrice}`);
        await snapshotEquity();
      } else if (st.status === 'cancelled') {
        await repo.updateOrderIntent(intent.id, cancelledPatch(st));
      }
      // 'submitted' → still resting (e.g. overnight DAY order): leave as-is.
    }
  }

  // Target weight is absolute, not incremental: if the same symbol has more than
  // one pending intent (a backlog built up while the executor/gateway was slow),
  // only the newest carries a target worth acting on -- the older ones are stale
  // reads of a since-superseded signal.
  // Separately, a symbol with an in-flight (submitted, unfilled) order must not
  // have another pending intent sized against it this tick: computeSizing sizes
  // against the account's *current* position, which doesn't yet reflect the
  // in-flight order's eventual fill -- sizing now would double-count.
  async function processPendingBacklog(trading) {
    const pending = await repo.listOrderIntentsByStatus('pending');
    const newestIdBySymbol = new Map();
    for (const intent of pending) {
      const prevId = newestIdBySymbol.get(intent.symbol);
      if (prevId === undefined || intent.id > prevId) newestIdBySymbol.set(intent.symbol, intent.id);
    }
    const submittedSymbols = new Set((await repo.listOrderIntentsByStatus('submitted')).map((i) => i.symbol));

    for (const intent of pending) {
      if (newestIdBySymbol.get(intent.symbol) !== intent.id) {
        // An older pending intent may secretly own a live order at the broker
        // (persist-failure or placeOrder-throw+probe-throw paths) -- reconcile
        // before writing it off, or that live order is orphaned under skipped
        // while the newer intent double-places. When the probe finds (or can't
        // rule out) a live order, defer the symbol for the rest of this tick.
        if (await reconcilePendingAtBroker(intent)) {
          submittedSymbols.add(intent.symbol);
          continue;
        }
        await repo.updateOrderIntent(intent.id, { status: 'skipped', skipReason: 'superseded' });
        continue;
      }
      if (submittedSymbols.has(intent.symbol)) continue; // in-flight order for this symbol: defer to a later tick
      await processPending(intent, trading);
    }
  }

  async function tick() {
    const resolved = await brokers.getBroker();
    broker = resolved.broker;
    // Log broker availability transitions, not every idle tick.
    const brokerKey = broker ? `${resolved.connection.broker}:${resolved.connection.name}` : null;
    if (brokerKey !== lastBrokerKey) {
      logger.info?.(
        broker
          ? `[executor] broker connected: ${brokerKey}${resolved.connection.paper ? ' (paper)' : ' (LIVE)'}`
          : '[executor] no active broker connection; executor idle',
      );
      lastBrokerKey = brokerKey;
    }
    if (!broker) return; // intents accumulate as pending until a connection is activated

    const trading = await tradingCfg();
    if (trading.enabled !== lastEnabled) {
      logger.info?.(`[executor] trading ${trading.enabled ? 'ENABLED' : 'disabled'}${trading.dryRun ? ' (dry-run)' : ''}`);
      lastEnabled = trading.enabled;
    }
    // Snapshots are hourly-in-market, not gated on trading being enabled — the
    // equity curve must not gap just because the kill switch is off.
    await maybeSnapshot();
    if (!trading.enabled) return;

    await trackSubmitted();
    await processPendingBacklog(trading);
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
