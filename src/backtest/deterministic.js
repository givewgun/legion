import { computeIndicators, quantStance } from './indicators.js';

const MIN_HISTORY = 50; // need sma50 before trading

function benchReturn(bench, fromDate, toDate) {
  const a = bench.find((c) => c.date === fromDate);
  const b = bench.find((c) => c.date === toDate);
  if (!a || !b || !a.close) return 0;
  return (b.close - a.close) / a.close;
}

export function runBacktest(candles, spy, qqq, { horizon }) {
  const closes = candles.map((c) => c.close);
  let trades = 0;
  let hits = 0;
  let pnl = 0;
  let spyPnl = 0;
  let qqqPnl = 0;

  for (let i = MIN_HISTORY; i + horizon < candles.length; i += 1) {
    const ind = computeIndicators(closes.slice(0, i + 1));
    const stance = quantStance(ind);
    if (stance === 0) continue;

    const dir = Math.sign(stance);
    const entry = candles[i];
    const exit = candles[i + horizon];
    if (!entry.close) continue;

    const tradeReturn = (dir * (exit.close - entry.close)) / entry.close;
    trades += 1;
    if (tradeReturn > 0) hits += 1;
    pnl += tradeReturn;
    spyPnl += dir * benchReturn(spy, entry.date, exit.date);
    qqqPnl += dir * benchReturn(qqq, entry.date, exit.date);
  }

  return {
    trades,
    hits,
    hitRate: trades ? hits / trades : 0,
    pnl,
    spyPnl,
    qqqPnl,
  };
}
