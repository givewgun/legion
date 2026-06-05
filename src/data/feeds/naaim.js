import { getJson, BROWSER_HEADERS } from './http.js';

// NAAIM Exposure Index (weekly): active managers' average US-equity exposure
// (0..100, can exceed via leverage). High exposure = crowded long = contrarian-
// bearish. Like AAII there is no confirmed free machine endpoint, so this fetcher
// returns `null` until a source URL is supplied via `sources.naaimUrl`; the parse
// path (expecting { exposure, date }) is ready for that swap.
export async function fetchNaaim({ fetchImpl, url } = {}) {
  if (!url) return null;
  try {
    const data = await getJson(url, { fetchImpl, headers: BROWSER_HEADERS });
    if (data?.exposure == null) return null;
    return { exposure: data.exposure, date: data.date ?? null };
  } catch {
    return null;
  }
}
