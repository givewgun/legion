// Live, quality-weighted paper book. Replaces the deterministic close-replay sim.
// Fills at the emit-time price captured on each signal (signal.entry_price, ADR
// 0009) and sizes by conviction × the qualityMult snapshotted on the signal
// (signal.plan.qualityMult). Open positions are marked to the current live price.
// Pure: callers supply signals (oldest-first) and a live-price map.

import { BAND_LONG } from '../sizing/engine.js';

const SellBands = new Set(['SELL', 'STRONG_SELL']);
const DayMs = 86400000;

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
      if (nowTs >= pos.resolveAfter) {
        // Horizon exits mark at the latest available price (live, or entry as fallback): per-date historical prices are not stored, so a long-past horizon close is an approximation. Open-position marks and benchmark bases remain the accurate, reproducible figures.
        close(symbol, livePrices[symbol] ?? pos.entryPrice, 'horizon');
      }
    }
    if (SellBands.has(s.band)) {
      if (open.has(s.symbol)) close(s.symbol, s.entry_price ?? livePrices[s.symbol] ?? open.get(s.symbol).entryPrice, 'sell-signal');
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
    const resolveAfter = s.resolve_after ? new Date(s.resolve_after).getTime() : new Date(s.created_at).getTime() + horizonDays * DayMs;
    open.set(s.symbol, { entryPrice: price, shares, trade, resolveAfter });
  }

  const openPositions = [...open.entries()].map(([symbol, pos]) => {
    const markPrice = livePrices[symbol] ?? pos.entryPrice;
    return { symbol, shares: pos.shares, entryPrice: pos.entryPrice, markPrice, marketValue: pos.shares * markPrice, unrealizedReturn: (markPrice - pos.entryPrice) / pos.entryPrice };
  });

  const markedEquity = cash + openPositions.reduce((s, p) => s + p.marketValue, 0);
  const closed = trades.filter((t) => t.exitReason !== 'open');

  // Benchmarks ride the captured entry prices from the first signal (ADR 0009),
  // marked at the current live SPY/QQQ price — same "entered at signal time" base
  // as the book's own startingCapital.
  const firstSig = ordered[0];
  const spyEntry = Number(firstSig?.spy_entry_price) || null;
  const qqqEntry = Number(firstSig?.qqq_entry_price) || null;
  const spyReturn = spyEntry && livePrices.SPY ? livePrices.SPY / spyEntry - 1 : 0;
  const qqqReturn = qqqEntry && livePrices.QQQ ? livePrices.QQQ / qqqEntry - 1 : 0;

  const stats = {
    totalReturn: markedEquity / startingCapital - 1,
    openValue: openPositions.reduce((s, p) => s + p.marketValue, 0),
    cash,
    trades: trades.length,
    winRate: closed.length ? closed.filter((t) => t.return > 0).length / closed.length : 0,
    spyReturn,
    qqqReturn,
  };
  // Single live data point; the historical curve is rebuilt by the route from
  // benchmark entry prices (Task 11). Here we expose the marked equity for now.
  const curve = [{ date: 'live', equity: markedEquity }];
  return { curve, trades, openPositions, stats };
}
