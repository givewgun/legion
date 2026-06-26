// Quality-weighted paper book. Replays Legion's emitted signals as a long-only
// paper portfolio and marks it to market daily against SPY / QQQ buy-and-hold,
// producing a time-series equity curve for the chart. Two things distinguish it
// from a plain backtest:
//   - Entries fill at the signal's emit-time price (signal.entry_price, ADR 0009),
//     not the next daily close — the "executed the instant the signal fired" base.
//   - Position size = conviction × the qualityMult snapshotted on the signal
//     (signal.plan.qualityMult) × baseWeight, capped at maxPerName and cash.
// Marking, horizon exits, and benchmarks use daily candle closes. A final live
// snapshot (current prices) marks the still-open positions for the live panel.
// Pure: callers supply signals, per-symbol candles, SPY/QQQ candles, and a
// current live-price map.

import { BAND_LONG } from '../sizing/engine.js';

const SellBands = new Set(['SELL', 'STRONG_SELL']);

// US equities close at 20:00 UTC (EDT) / 21:00 UTC (EST). Fills are placed on the
// first trading day whose close the signal could have caught; a signal emitted
// after this cutoff rolls to the next day (matches the old sim and the resolver).
const UsCloseUtcHour = 20;

function fillDayOf(ts) {
  const d = new Date(ts);
  if (d.getUTCHours() >= UsCloseUtcHour) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildPaperBook(signals, { candlesBySymbol = {}, spy = [], qqq = [], livePrices = {} }, { startingCapital, horizonDays, baseWeight, maxPerName }) {
  // SPY's dates are the trading calendar; per-symbol closes are keyed by date.
  const calendar = spy.map((c) => c.date);
  const closesBySymbol = new Map(
    Object.entries(candlesBySymbol).map(([symbol, candles]) => [
      symbol,
      new Map(candles.map((c) => [c.date, c.close])),
    ]),
  );
  const spyCloses = new Map(spy.map((c) => [c.date, c.close]));
  const qqqCloses = new Map(qqq.map((c) => [c.date, c.close]));
  const priceOn = (symbol, date) => closesBySymbol.get(symbol)?.get(date);

  // Group signals by the first trading day whose close they could catch.
  const ordered = [...signals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const signalsByDay = new Map();
  for (const sig of ordered) {
    const day = calendar.find((d) => d >= fillDayOf(sig.created_at));
    if (!day) continue; // emitted after the last candle — nothing to mark against
    if (!signalsByDay.has(day)) signalsByDay.set(day, []);
    signalsByDay.get(day).push(sig);
  }

  const curve = [];
  const trades = [];
  const tradeDays = [...signalsByDay.keys()].sort();
  if (tradeDays.length === 0) {
    return { curve, trades, openPositions: [], stats: emptyStats() };
  }

  const startIdx = calendar.indexOf(tradeDays[0]);
  const spyStart = spyCloses.get(calendar[startIdx]);
  const qqqStart = qqqCloses.get(calendar[startIdx]);
  let lastQqqClose = qqqStart;

  let cash = startingCapital;
  const open = new Map(); // symbol → { entryIdx, entryPrice, shares, lastPrice, trade }

  function markedEquity(date) {
    let value = cash;
    for (const [symbol, pos] of open) value += pos.shares * (priceOn(symbol, date) ?? pos.lastPrice);
    return value;
  }

  function closePosition(symbol, date, exitReason) {
    const pos = open.get(symbol);
    const price = priceOn(symbol, date) ?? pos.lastPrice;
    cash += pos.shares * price;
    Object.assign(pos.trade, {
      exitDate: date,
      exitPrice: price,
      return: (price - pos.entryPrice) / pos.entryPrice,
      exitReason,
    });
    open.delete(symbol);
  }

  for (let i = startIdx; i < calendar.length; i += 1) {
    const date = calendar[i];

    // 1. Horizon exits (horizonDays trading days after entry).
    for (const [symbol, pos] of [...open]) {
      if (i - pos.entryIdx >= horizonDays) closePosition(symbol, date, 'horizon');
    }

    // 2. Today's signals: sells close, buys open at the emit-time entry price.
    for (const sig of signalsByDay.get(date) ?? []) {
      const conviction = Number(sig.conviction);
      if (SellBands.has(sig.band)) {
        if (open.has(sig.symbol)) closePosition(sig.symbol, date, 'sell-signal');
        continue;
      }
      if (!BAND_LONG.has(sig.band) || conviction <= 0) continue;
      if (open.has(sig.symbol)) continue; // no pyramiding
      const entryPrice = Number(sig.entry_price) || priceOn(sig.symbol, date);
      if (!entryPrice) continue;
      const qualityMult = Number(sig.plan?.qualityMult ?? 1);
      const weight = Math.max(0, Math.min(baseWeight * conviction * qualityMult, maxPerName));
      const cost = Math.min(weight * markedEquity(date), cash);
      if (cost <= 0) continue;
      const shares = cost / entryPrice;
      cash -= cost;
      const trade = {
        symbol: sig.symbol,
        band: sig.band,
        conviction,
        qualityMult,
        entryDate: date,
        entryPrice,
        shares,
        exitDate: null,
        exitPrice: null,
        return: null,
        exitReason: 'open',
      };
      trades.push(trade);
      open.set(sig.symbol, { entryIdx: i, entryPrice, shares, lastPrice: entryPrice, trade });
    }

    // 3. Mark to market (carry the last known price across missing candles).
    for (const [symbol, pos] of open) {
      const price = priceOn(symbol, date);
      if (price) pos.lastPrice = price;
    }
    const qqqClose = qqqCloses.get(date);
    if (qqqClose) lastQqqClose = qqqClose;
    curve.push({
      date,
      equity: markedEquity(date),
      spy: spyStart ? (startingCapital * spyCloses.get(date)) / spyStart : startingCapital,
      qqq: qqqStart ? (startingCapital * lastQqqClose) / qqqStart : startingCapital,
    });
  }

  // Live snapshot: mark the still-open positions at the current price for the
  // live panel (entry price as a fallback when a symbol has no live quote).
  const openPositions = [...open.entries()].map(([symbol, pos]) => {
    const markPrice = livePrices[symbol] ?? pos.lastPrice;
    return {
      symbol,
      shares: pos.shares,
      entryPrice: pos.entryPrice,
      markPrice,
      marketValue: pos.shares * markPrice,
      unrealizedReturn: (markPrice - pos.entryPrice) / pos.entryPrice,
    };
  });
  // Unrealized return on positions still open at the end of the calendar (uses
  // the last candle close, consistent with the curve's final point).
  for (const pos of open.values()) pos.trade.return = (pos.lastPrice - pos.entryPrice) / pos.entryPrice;

  return { curve, trades, openPositions, stats: buildStats(curve, trades, startingCapital) };
}

function emptyStats() {
  return { totalReturn: 0, spyReturn: 0, qqqReturn: 0, maxDrawdown: 0, winRate: 0, trades: 0 };
}

function buildStats(curve, trades, startingCapital) {
  const last = curve.at(-1);
  const closed = trades.filter((t) => t.exitReason !== 'open');
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
  }
  return {
    totalReturn: last ? last.equity / startingCapital - 1 : 0,
    spyReturn: last ? last.spy / startingCapital - 1 : 0,
    qqqReturn: last ? last.qqq / startingCapital - 1 : 0,
    maxDrawdown,
    winRate: closed.length ? closed.filter((t) => t.return > 0).length / closed.length : 0,
    trades: trades.length,
  };
}
