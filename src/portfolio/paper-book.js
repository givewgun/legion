// Live, quality-weighted paper book. Replaces the deterministic close-replay sim.
// Fills at the emit-time price captured on each signal (signal.entry_price, ADR
// 0009) and sizes by conviction × the qualityMult snapshotted on the signal
// (signal.plan.qualityMult). Open positions are marked to the current live price.
// Pure: callers supply signals (oldest-first) and a live-price map.

import { BAND_LONG } from '../sizing/engine.js';

const SellBands = new Set(['SELL', 'STRONG_SELL']);

export function buildPaperBook(signals, livePrices, { startingCapital, horizonDays, baseWeight, maxPerName }) {
  const ordered = [...signals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let cash = startingCapital;
  const open = new Map(); // symbol → { entryPrice, shares, trade, resolveAfter }
  const trades = [];

  const equity = () => cash + [...open.values()].reduce((s, p) => s + p.shares * p.entryPrice, 0);

  const close = (symbol, price, reason) => {
    const pos = open.get(symbol);
    cash += pos.shares * price;
    Object.assign(pos.trade, { exitPrice: price, return: (price - pos.entryPrice) / pos.entryPrice, exitReason: reason });
    open.delete(symbol);
  };

  for (const s of ordered) {
    // Horizon exits for anything whose window closed before this signal's time.
    const nowTs = new Date(s.created_at).getTime();
    for (const [symbol, pos] of [...open]) {
      if (pos.resolveAfter && nowTs >= new Date(pos.resolveAfter).getTime()) {
        close(symbol, livePrices[symbol] ?? pos.entryPrice, 'horizon');
      }
    }
    if (SellBands.has(s.band)) {
      if (open.has(s.symbol)) close(s.symbol, s.entry_price ?? livePrices[s.symbol], 'sell-signal');
      continue;
    }
    const conviction = Number(s.conviction);
    if (!BAND_LONG.has(s.band) || conviction <= 0) continue;
    if (open.has(s.symbol)) continue; // no pyramiding
    const price = Number(s.entry_price);
    if (!price) continue;
    const qualityMult = Number(s.plan?.qualityMult ?? 1);
    const weight = Math.max(0, Math.min(baseWeight * conviction * qualityMult, maxPerName));
    const cost = Math.min(weight * equity(), cash);
    if (cost <= 0) continue;
    const shares = cost / price;
    cash -= cost;
    const trade = { symbol: s.symbol, band: s.band, conviction, qualityMult, entryDate: s.created_at, entryPrice: price, shares, exitPrice: null, return: null, exitReason: 'open' };
    trades.push(trade);
    open.set(s.symbol, { entryPrice: price, shares, trade, resolveAfter: s.resolve_after });
  }

  const openPositions = [...open.entries()].map(([symbol, pos]) => {
    const markPrice = livePrices[symbol] ?? pos.entryPrice;
    return { symbol, shares: pos.shares, entryPrice: pos.entryPrice, markPrice, marketValue: pos.shares * markPrice, unrealizedReturn: (markPrice - pos.entryPrice) / pos.entryPrice };
  });

  const markedEquity = cash + openPositions.reduce((s, p) => s + p.marketValue, 0);
  const closed = trades.filter((t) => t.exitReason !== 'open');
  const stats = {
    totalReturn: markedEquity / startingCapital - 1,
    openValue: openPositions.reduce((s, p) => s + p.marketValue, 0),
    cash,
    trades: trades.length,
    winRate: closed.length ? closed.filter((t) => t.return > 0).length / closed.length : 0,
  };
  // Single live data point; the historical curve is rebuilt by the route from
  // benchmark entry prices (Task 11). Here we expose the marked equity for now.
  const curve = [{ date: 'live', equity: markedEquity }];
  return { curve, trades, openPositions, stats };
}
