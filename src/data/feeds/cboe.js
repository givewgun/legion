import { getText, BROWSER_HEADERS } from './http.js';

// CBOE publishes a put/call CSV (DATE, CALL, PUT, TOTAL, P/C Ratio). A high ratio
// = fear = contrarian-bullish. NOTE: CBOE's public CSV is currently stale; the
// live daily series now sits behind their stats page / DataShop with no confirmed
// free JSON. This fetcher parses whatever CSV the configured URL returns and is
// ready to point at a live source; until then it degrades to `null`.
const DEFAULT_URL =
  'https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv';
const DATE_RE = /^(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})$/;

export async function fetchPutCall({ fetchImpl, url = DEFAULT_URL } = {}) {
  try {
    const text = await getText(url, { fetchImpl, headers: BROWSER_HEADERS });
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    // Walk from the last row up to the most recent line that looks like data.
    for (let i = lines.length - 1; i >= 0; i--) {
      const cols = lines[i].split(',').map((c) => c.trim());
      const ratio = Number(cols[cols.length - 1]);
      if (cols.length >= 2 && DATE_RE.test(cols[0]) && !Number.isNaN(ratio)) {
        return { ratio, date: cols[0] };
      }
    }
    return null;
  } catch {
    return null;
  }
}
