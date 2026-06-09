// Thin read client over the GunVest REST API. fetchImpl is injectable for tests.
//
// Resilience: a scheduler sweep fans every enabled ticker out at once, and each
// agent process gathers all of them concurrently (× up to 3 rounds), bursting a
// single-threaded GunVest. Unbounded that produces transient `fetch failed`
// (ECONNRESET / connect-timeout) scattered across agents. So every request goes
// through: a bounded concurrency limiter (no self-inflicted thundering herd), a
// per-request timeout, and retry-with-jittered-backoff on transient transport
// errors and retryable 5xx/429. Both the limiter and the backoff are the shared
// util/resilient.js helpers (one tested implementation, also used by the Ollama
// provider). The underlying cause is surfaced in the thrown message so a
// remaining abstain is diagnosable.
import { createLimiter, retryAsync } from '../util/resilient.js';

const RetryableStatus = new Set([429, 500, 502, 503, 504]);
const DefaultRetries = 2;
const DefaultRetryBaseMs = 200;
// Caps the exponential backoff term; keeps a larger `retries` from growing the
// delay without bound (at the default retries=2 the term never reaches it).
const DefaultRetryMaxMs = 2000;
// Raised from 8s: under a scheduler sweep the single-threaded GunVest serialises
// every ticker's /api/news fetch, and the slower upstream news provider can blow
// the old budget (× retries) into a `timeout after Nms` abstain. 15s leaves
// headroom without letting a genuinely hung request stall a cycle indefinitely.
const DefaultTimeoutMs = 15000;
const DefaultMaxConcurrent = 6;
// The macro snapshot (rates, VIX, regime) is global, not per-ticker, yet every
// agent re-fetches it once per ticker per round — multiplying load on GunVest
// during a sweep. A short TTL collapses those into one shared in-flight request.
const DefaultMacroTtlMs = 60000;

function describeError(err, timeoutMs) {
  if (err?.name === 'AbortError') return `timeout after ${timeoutMs}ms`;
  return err?.cause?.code || err?.cause?.message || err?.code || err?.message || 'network error';
}

export function createGunvestClient(baseUrl, fetchImpl = fetch, opts = {}) {
  const {
    retries = DefaultRetries,
    retryBaseMs = DefaultRetryBaseMs,
    retryMaxMs = DefaultRetryMaxMs,
    timeoutMs = DefaultTimeoutMs,
    maxConcurrent = DefaultMaxConcurrent,
    macroTtlMs = DefaultMacroTtlMs,
  } = opts;
  const limit = createLimiter(maxConcurrent);

  async function fetchOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // One fetch attempt resolved to an ok Response, or a classified throw: transport
  // failures and retryable 5xx/429 are flagged `transient` so retryAsync retries
  // them; non-retryable statuses (e.g. 404) are not, so they fail fast.
  async function attemptFetch(path, url) {
    let res;
    try {
      res = await fetchOnce(url);
    } catch (err) {
      throw Object.assign(
        new Error(`GunVest API GET ${path} failed: ${describeError(err, timeoutMs)}`),
        { transient: true },
      );
    }
    if (res.ok) return res;
    throw Object.assign(new Error(`GunVest API GET ${path} -> ${res.status}`), {
      transient: RetryableStatus.has(res.status),
    });
  }

  function fetchOk(path) {
    const url = `${baseUrl}${path}`;
    return retryAsync(() => attemptFetch(path, url), {
      retries,
      baseMs: retryBaseMs,
      maxDelayMs: retryMaxMs,
      isTransient: (err) => err.transient === true,
    });
  }

  async function get(path) {
    return limit(async () => {
      const res = await fetchOk(path);
      return res.json();
    });
  }

  // Deduped macro fetch: concurrent callers within the TTL share one in-flight
  // promise so a sweep hits /api/macro once, not once-per-ticker. A rejected
  // fetch is evicted immediately so the next caller retries rather than
  // inheriting the cached failure. macroTtlMs <= 0 disables caching.
  let macroEntry = null;
  function getMacro() {
    const now = Date.now();
    if (macroEntry && now - macroEntry.at < macroTtlMs) return macroEntry.promise;
    const promise = get('/api/macro');
    macroEntry = { at: now, promise };
    promise.catch(() => {
      if (macroEntry?.promise === promise) macroEntry = null;
    });
    return promise;
  }

  return {
    getPrice: (symbol) => get(`/api/market/${symbol.toUpperCase()}`),
    getNews: (symbol) => get(`/api/news/${symbol.toUpperCase()}`),
    getSentiment: (symbol) => get(`/api/sentiment/${symbol.toUpperCase()}`),
    getStockFearGreed: () => get(`/api/sentiment/stock/fear-greed`),
    getMacro,
    getCandles: async (symbol, days) => {
      const body = await get(`/api/market/${symbol.toUpperCase()}/candles?days=${days}`);
      return (body.candles ?? []).map((c) => ({ date: c.date, close: c.close }));
    },
  };
}

// Convenience wrapper for the run entrypoints: builds a client from loaded config
// so the resilience knobs (timeout/retries/concurrency/macro TTL) are tuned via
// env in one place instead of hardcoded at each call site.
export function createGunvestFromConfig(cfg, fetchImpl = fetch) {
  return createGunvestClient(cfg.gunvestApiUrl, fetchImpl, cfg.gunvest);
}
