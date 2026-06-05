import { getJson, BROWSER_HEADERS } from './http.js';

// AAII bull/bear sentiment survey (weekly). High bullish share = greed =
// contrarian-bearish. No confirmed free machine endpoint exists, so this fetcher
// stays dormant (returns `null`) until a source URL is supplied via `sources.aaiiUrl`;
// the parse path (expecting { bullish, bearish, neutral } as 0..1 fractions) is
// ready so flipping it on is a one-line config change.
export async function fetchAaii({ fetchImpl, url } = {}) {
  if (!url) return null;
  try {
    const data = await getJson(url, { fetchImpl, headers: BROWSER_HEADERS });
    if (data?.bullish == null || data?.bearish == null) return null;
    const { bullish, bearish, neutral = null } = data;
    return { bullish, bearish, neutral, spread: bullish - bearish };
  } catch {
    return null;
  }
}
