// Pure technical indicators derived from a daily-close history. GunVest's
// per-ticker price endpoint returns ~1y of { date, close } points; this turns
// that raw series into the trend/momentum/volatility signals the Technical
// agent reasons over. Every function is null-safe: too-short history simply
// omits the indicators it cannot compute (never throws).

// Trading-day windows (approximate calendar months/quarter).
const Month = 21;
const Quarter = 63;
const RsiPeriod = 14;
const VolWindow = 21;
const TradingDaysPerYear = 252;

function closesOf(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => Number(h && typeof h === 'object' ? h.close : h))
    .filter(Number.isFinite);
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Simple moving average over the trailing `n` closes.
function sma(closes, n) {
  return closes.length >= n ? mean(closes.slice(-n)) : undefined;
}

// Wilder RSI over the trailing `period` changes. 100 when there are no losses.
function rsi(closes, period = RsiPeriod) {
  if (closes.length < period + 1) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = gains / period / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Percent return from `k` sessions ago to the latest close.
function returnOver(closes, k) {
  if (closes.length <= k) return undefined;
  const past = closes[closes.length - 1 - k];
  return past ? (closes.at(-1) / past - 1) * 100 : undefined;
}

// Annualized realized volatility (%) from the trailing daily log returns.
function volatility(closes, window = VolWindow) {
  if (closes.length < 2) return undefined;
  const series = closes.slice(-(window + 1));
  const rets = series.slice(1).map((c, i) => Math.log(c / series[i]));
  const mu = mean(rets);
  const variance = mean(rets.map((r) => (r - mu) ** 2));
  return Math.sqrt(variance) * Math.sqrt(TradingDaysPerYear) * 100;
}

// Builds the indicator bundle, omitting any field that history is too short to
// support. Returns {} for empty/garbage input.
export function computeIndicators(history) {
  const closes = closesOf(history);
  if (closes.length === 0) return {};

  const latestClose = closes.at(-1);
  const high = Math.max(...closes);
  const low = Math.min(...closes);

  const out = {
    latestClose,
    samples: closes.length,
    fiftyTwoWeekHigh: high,
    fiftyTwoWeekLow: low,
    pctFromHigh: (latestClose - high) / high * 100,
    pctFromLow: (latestClose - low) / low * 100,
  };

  const optional = {
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi14: rsi(closes),
    return1m: returnOver(closes, Month),
    return3m: returnOver(closes, Quarter),
    volatility: volatility(closes),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
