import { getJson, BROWSER_HEADERS } from './http.js';

// CBOE 5-day put/call ratio sourced from CNN Fear & Greed graphdata API.
// The `put_call_options` sub-indicator exposes the raw CBOE ratio in its `data`
// array (latest = last element). A high ratio = fear = contrarian-bullish.
const DEFAULT_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';

// CNN's edge CDN requires browser-like headers; bare Node UA returns HTTP 418.
const CNN_HEADERS = {
  ...BROWSER_HEADERS,
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.cnn.com/markets/fear-and-greed',
  Origin: 'https://www.cnn.com',
};

export async function fetchPutCall({ fetchImpl, url = DEFAULT_URL } = {}) {
  try {
    const body = await getJson(url, { fetchImpl, headers: CNN_HEADERS });
    const pco = body?.put_call_options;
    if (!pco || !Array.isArray(pco.data) || pco.data.length === 0) return null;

    const latest = pco.data[pco.data.length - 1];
    const ratio = latest.y;
    const date = new Date(latest.x).toISOString().slice(0, 10);
    const score = pco.score ?? null;
    const rating = pco.rating ?? null;

    return { ratio, score, rating, date };
  } catch {
    return null;
  }
}
