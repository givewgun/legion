import { getText, BROWSER_HEADERS } from './http.js';

// AAII bull/bear survey scraped from aaii.com; high bullish share = greed =
// contrarian-bearish; HTML scrape so it is layout-fragile and degrades to null.
const DEFAULT_URL = 'https://www.aaii.com/sentimentsurvey/sent_results';

const HTML_HEADERS = { ...BROWSER_HEADERS, Accept: 'text/html,application/xhtml+xml,*/*' };

export async function fetchAaii({ fetchImpl, url = DEFAULT_URL } = {}) {
  try {
    const html = await getText(url, { fetchImpl, headers: HTML_HEADERS });
    const re = /class="tableTxt"\s*>\s*([0-9]{1,3}(?:\.[0-9]+)?)%/gi;
    const matches = [];
    let m;
    while ((m = re.exec(html)) !== null && matches.length < 3) {
      matches.push(parseFloat(m[1]));
    }
    if (matches.length < 3 || matches.some((v) => isNaN(v))) return null;
    const [bullish, neutral, bearish] = matches;
    return { bullish, neutral, bearish, spread: bullish - bearish };
  } catch {
    return null;
  }
}
