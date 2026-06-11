// Replays Legion's emitted signals as a paper, long-only portfolio and marks it
// to market daily against SPY / QQQ buy-and-hold benchmarks. Pure function —
// callers supply signals and candles; no I/O here (same pattern as
// backtest/deterministic.js).
//
// Trade rules (docs/superpowers/specs/2026-06-10-simulated-portfolio-design.md):
// - BUY/STRONG_BUY opens a long sized conviction × maxPositionFraction × equity,
//   capped at available cash. No pyramiding: a symbol already held is skipped.
// - SELL/STRONG_SELL closes any open position in that symbol. No shorts.
// - HOLD / NO_CONSENSUS / zero conviction are ignored.
// - All fills happen at the daily close of the first trading day whose close
//   comes after the signal fired (signals emitted after the US close roll to
//   the next trading day — no intraday execution, no stale-close fills).
// - Positions auto-close horizonDays *trading days* after entry — the same
//   window the reliability resolver scores signals against.

const DefaultStartingCapital = 100_000;
const DefaultHorizonDays = 5;
// Fraction of current equity a full-conviction position takes.
const DefaultMaxPositionFraction = 0.1;

const BuyBands = new Set(['BUY', 'STRONG_BUY']);
const SellBands = new Set(['SELL', 'STRONG_SELL']);

// US equities close at 20:00 UTC (EDT) or 21:00 UTC (EST). All fills happen at
// the daily close, so a signal emitted at/after the close can only catch the
// NEXT day's close. Using the earlier (EDT) cutoff guarantees we never fill at
// a close that had already printed when the signal fired; in winter a signal in
// the 20:00–21:00 UTC window conservatively rolls forward one day.
const UsCloseUtcHour = 20;

// First calendar day (yyyy-mm-dd, UTC) whose close the signal could have been
// traded at: its own day, or the next if it fired after the close cutoff.
function fillDayOf(ts) {
  const d = new Date(ts);
  if (d.getUTCHours() >= UsCloseUtcHour) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function simulatePortfolio(signals, candlesBySymbol, spy, qqq, opts = {}) {
  const {
    startingCapital = DefaultStartingCapital,
    horizonDays = DefaultHorizonDays,
    maxPositionFraction = DefaultMaxPositionFraction,
  } = opts;

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
  let skipped = 0;
  const signalsByDay = new Map();
  const ordered = [...signals].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const sig of ordered) {
    const day = calendar.find((d) => d >= fillDayOf(sig.created_at));
    if (!day) {
      skipped += 1; // emitted after the last candle — nothing to trade against
      continue;
    }
    if (!signalsByDay.has(day)) signalsByDay.set(day, []);
    signalsByDay.get(day).push(sig);
  }

  const curve = [];
  const trades = [];
  const tradeDays = [...signalsByDay.keys()].sort();
  if (tradeDays.length === 0) {
    return { curve, trades, stats: buildStats(curve, trades, startingCapital, skipped) };
  }

  const startIdx = calendar.indexOf(tradeDays[0]);
  const spyStart = spyCloses.get(calendar[startIdx]);
  let lastQqqClose = qqqCloses.get(calendar[startIdx]);
  const qqqStart = lastQqqClose;

  let cash = startingCapital;
  const open = new Map(); // symbol → { entryIdx, entryPrice, shares, lastPrice, trade }

  function markedEquity(date) {
    let value = cash;
    for (const [symbol, pos] of open) {
      value += pos.shares * (priceOn(symbol, date) ?? pos.lastPrice);
    }
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

    // 1. Horizon exits.
    for (const [symbol, pos] of [...open]) {
      if (i - pos.entryIdx >= horizonDays) closePosition(symbol, date, 'horizon');
    }

    // 2. Today's signals: sells close, buys open.
    for (const sig of signalsByDay.get(date) ?? []) {
      const conviction = Number(sig.conviction);
      if (SellBands.has(sig.band)) {
        if (open.has(sig.symbol)) closePosition(sig.symbol, date, 'sell-signal');
        continue;
      }
      if (!BuyBands.has(sig.band) || conviction <= 0) continue;
      if (open.has(sig.symbol)) continue; // no pyramiding
      const price = priceOn(sig.symbol, date);
      if (!price) {
        skipped += 1;
        continue;
      }
      const cost = Math.min(conviction * maxPositionFraction * markedEquity(date), cash);
      if (cost <= 0) continue;
      const shares = cost / price;
      cash -= cost;
      const trade = {
        symbol: sig.symbol,
        band: sig.band,
        conviction,
        entryDate: date,
        entryPrice: price,
        shares,
        exitDate: null,
        exitPrice: null,
        return: null,
        exitReason: 'open',
      };
      trades.push(trade);
      open.set(sig.symbol, { entryIdx: i, entryPrice: price, shares, lastPrice: price, trade });
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
      spy: (startingCapital * spyCloses.get(date)) / spyStart,
      qqq: qqqStart ? (startingCapital * lastQqqClose) / qqqStart : startingCapital,
    });
  }

  // Unrealized return on positions still open at the end of the calendar.
  for (const pos of open.values()) {
    pos.trade.return = (pos.lastPrice - pos.entryPrice) / pos.entryPrice;
  }

  return { curve, trades, stats: buildStats(curve, trades, startingCapital, skipped) };
}

function buildStats(curve, trades, startingCapital, skipped) {
  const last = curve.at(-1);
  const closed = trades.filter((t) => t.exitReason !== 'open');
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
  }
  return {
    totalReturn: last ? last.equity / startingCapital - 1 : 0,
    spyReturn: last ? last.spy / startingCapital - 1 : 0,
    qqqReturn: last ? last.qqq / startingCapital - 1 : 0,
    maxDrawdown,
    winRate: closed.length ? closed.filter((t) => t.return > 0).length / closed.length : 0,
    trades: trades.length,
    skipped,
  };
}
