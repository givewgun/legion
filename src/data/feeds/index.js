import { createTtlCache } from './cache.js';
import { fetchPutCall } from './cboe.js';
import { fetchAaii } from './aaii.js';
import { fetchNaaim } from './naaim.js';
import { fetchShortInterest } from './finnhub.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The contrarian's crowd-positioning panel. F&G and VIX are reused from GunVest
// (the source of truth); put/call, AAII, NAAIM, and short interest are fetched
// legion-side. Every source is isolated, TTL-cached, and degraded to `null` on
// failure, so a dead upstream never blocks or crashes the agent.
// put/call is sourced live from CNN Fear & Greed graphdata (`put_call_options`)
// which exposes the CBOE 5-day put/call ratio; no API key required.
export function createContrarianFeeds({
  gunvest,
  finnhubApiKey,
  fetchImpl = fetch,
  cache = createTtlCache(),
  sources = {},
  logger = console,
}) {
  async function safe(label, fn) {
    try {
      return await fn();
    } catch (err) {
      logger.warn(`[feeds] ${label} unavailable: ${err.message}`);
      return null;
    }
  }

  async function gather(symbol) {
    const sym = symbol.toUpperCase();
    const [fearGreed, vix, putCall, aaii, naaim, shortInterest] = await Promise.all([
      safe('fearGreed', () =>
        cache.getOrFetch('fearGreed', HOUR, () => gunvest.getStockFearGreed()),
      ),
      safe('vix', () =>
        cache.getOrFetch('vix', HOUR, async () => (await gunvest.getMacro())?.vix ?? null),
      ),
      safe('putCall', () =>
        cache.getOrFetch('putCall', 6 * HOUR, () =>
          fetchPutCall({ fetchImpl, url: sources.cboeUrl }),
        ),
      ),
      safe('aaii', () =>
        cache.getOrFetch('aaii', DAY, () => fetchAaii({ fetchImpl, url: sources.aaiiUrl })),
      ),
      safe('naaim', () =>
        cache.getOrFetch('naaim', DAY, () => fetchNaaim({ fetchImpl, url: sources.naaimUrl })),
      ),
      safe('shortInterest', () =>
        cache.getOrFetch(`shortInterest:${sym}`, DAY, () =>
          fetchShortInterest({ symbol: sym, apiKey: finnhubApiKey, fetchImpl }),
        ),
      ),
    ]);
    return { fearGreed, vix, putCall, aaii, naaim, shortInterest };
  }

  return { gather };
}
