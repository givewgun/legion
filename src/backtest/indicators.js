export const RSI_OVERSOLD = 30;
export const RSI_OVERBOUGHT = 70;

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // seed with SMA of the first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  if (emaFast == null || emaSlow == null) return { macd: null, signal: null };
  const line = emaFast - emaSlow;
  // signal = EMA of the macd line; approximate using a short tail of macd lines
  const lines = [];
  for (let i = slow; i <= values.length; i += 1) {
    const sub = values.slice(0, i);
    const f = ema(sub, fast);
    const s = ema(sub, slow);
    if (f != null && s != null) lines.push(f - s);
  }
  const signal = ema(lines, signalPeriod) ?? line;
  return { macd: line, signal };
}

export function computeIndicators(closes) {
  const { macd: macdLine, signal } = macd(closes);
  return {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    rsi: rsi(closes, 14),
    macd: macdLine,
    signal,
  };
}

export function quantStance(ind) {
  if (ind.sma20 == null || ind.sma50 == null || ind.macd == null || ind.rsi == null) {
    return 0;
  }
  // Trend (SMA cross) sets the side; no trend → HOLD.
  const trend = ind.sma20 > ind.sma50 ? 1 : ind.sma20 < ind.sma50 ? -1 : 0;
  if (trend === 0) return 0;
  // Confirming momentum (MACD vs signal) escalates conviction to ±2.
  const momentum = ind.macd > ind.signal ? 1 : ind.macd < ind.signal ? -1 : 0;
  let score = momentum === trend ? trend * 2 : trend;
  // An RSI extreme against an over-extended (±2) reading de-escalates it to ±1;
  // it never flips the side or zeroes out the trend.
  if (score === 2 && ind.rsi > RSI_OVERBOUGHT) score = 1;
  if (score === -2 && ind.rsi < RSI_OVERSOLD) score = -1;
  return score;
}
