// Minimal HTTP helpers for the contrarian feeds. Each GET has a hard timeout and
// throws on non-2xx / network failure; the per-source fetchers convert throws to
// `null` so an unreachable upstream never blocks a vote.

// Browser-ish headers: some upstreams (CDN/edge) reject default Node UAs.
export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

async function get(url, { fetchImpl = fetch, headers = {}, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, opts) {
  const res = await get(url, opts);
  return res.json();
}

export async function getText(url, opts) {
  const res = await get(url, opts);
  return res.text();
}
