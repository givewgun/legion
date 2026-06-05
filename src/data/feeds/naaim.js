import { getText, BROWSER_HEADERS } from './http.js';

// NAAIM exposure scraped from YCharts; high exposure = crowded long =
// contrarian-bearish; HTML scrape, layout-fragile, degrades to null.
const DEFAULT_URL = 'https://ycharts.com/indicators/naaim_number';

const HTML_HEADERS = { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' };

export async function fetchNaaim({ fetchImpl, url = DEFAULT_URL } = {}) {
  try {
    const html = await getText(url, { fetchImpl, headers: HTML_HEADERS });
    const after = html.split('key-stat')[1];
    if (!after) return null;
    const m = after.match(/>\s*(-?[0-9]{1,3}(?:\.[0-9]+)?)\s*</);
    if (!m) return null;
    const exposure = parseFloat(m[1]);
    if (isNaN(exposure)) return null;
    return { exposure, date: null };
  } catch {
    return null;
  }
}
