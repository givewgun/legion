import { getJson } from './http.js';

const HOST = 'https://finnhub.io/api/v1';
const LOOKBACK_DAYS = 120;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

// Per-ticker short interest from Finnhub (free tier, token auth). Crowded shorts
// are squeeze fuel — a contrarian-bullish tell. Returns the latest settlement's
// value, or `null` when no key, no data, or the endpoint is unavailable/premium.
export async function fetchShortInterest({ symbol, apiKey, fetchImpl }) {
  if (!apiKey) return null;
  try {
    const url =
      `${HOST}/stock/short-interest?symbol=${encodeURIComponent(symbol)}` +
      `&from=${isoDaysAgo(LOOKBACK_DAYS)}&to=${isoDaysAgo(0)}&token=${apiKey}`;
    const data = await getJson(url, { fetchImpl });
    const rows = Array.isArray(data?.data) ? data.data : [];
    if (rows.length === 0) return null;
    const latest = rows[rows.length - 1];
    return { shortInterest: latest.shortInterest ?? null, date: latest.settlementDate ?? null };
  } catch {
    return null;
  }
}
