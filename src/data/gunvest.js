// Thin read client over the GunVest REST API. fetchImpl is injectable for tests.
//
// Resilience: a scheduler sweep fans every enabled ticker out at once, and each
// agent process gathers all of them concurrently (× up to 3 rounds), bursting a
// single-threaded GunVest. Unbounded that produces transient `fetch failed`
// (ECONNRESET / connect-timeout) scattered across agents. So every request goes
// through: a bounded concurrency limiter (no self-inflicted thundering herd), a
// per-request timeout, and retry-with-jittered-backoff on transient transport
// errors and retryable 5xx/429. The underlying cause is surfaced in the thrown
// message so a remaining abstain is diagnosable.

const RetryableStatus = new Set([429, 500, 502, 503, 504]);
const DefaultRetries = 2;
const DefaultRetryBaseMs = 200;
const DefaultTimeoutMs = 8000;
const DefaultMaxConcurrent = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounds concurrent work to `max`; extra calls queue and run as slots free.
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

function describeError(err, timeoutMs) {
  if (err?.name === 'AbortError') return `timeout after ${timeoutMs}ms`;
  return err?.cause?.code || err?.cause?.message || err?.code || err?.message || 'network error';
}

export function createGunvestClient(baseUrl, fetchImpl = fetch, opts = {}) {
  const {
    retries = DefaultRetries,
    retryBaseMs = DefaultRetryBaseMs,
    timeoutMs = DefaultTimeoutMs,
    maxConcurrent = DefaultMaxConcurrent,
  } = opts;
  const limit = createLimiter(maxConcurrent);

  const backoff = (attempt) =>
    sleep(retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * retryBaseMs));

  async function fetchOnce(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Resolves to an ok Response or throws. Retries transport failures and
  // retryable statuses up to `retries` times; non-retryable statuses (e.g. 404)
  // fail fast.
  async function fetchOk(path) {
    const url = `${baseUrl}${path}`;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetchOnce(url);
      } catch (err) {
        if (attempt++ < retries) {
          await backoff(attempt);
          continue;
        }
        throw new Error(`GunVest API GET ${path} failed: ${describeError(err, timeoutMs)}`);
      }
      if (res.ok) return res;
      if (RetryableStatus.has(res.status) && attempt++ < retries) {
        await backoff(attempt);
        continue;
      }
      throw new Error(`GunVest API GET ${path} -> ${res.status}`);
    }
  }

  async function get(path) {
    return limit(async () => {
      const res = await fetchOk(path);
      return res.json();
    });
  }

  return {
    getPrice: (symbol) => get(`/api/market/${symbol.toUpperCase()}`),
    getNews: (symbol) => get(`/api/news/${symbol.toUpperCase()}`),
    getSentiment: (symbol) => get(`/api/sentiment/${symbol.toUpperCase()}`),
    getStockFearGreed: () => get(`/api/sentiment/stock/fear-greed`),
    getMacro: () => get(`/api/macro`),
    getCandles: async (symbol, days) => {
      const body = await get(`/api/market/${symbol.toUpperCase()}/candles?days=${days}`);
      return (body.candles ?? []).map((c) => ({ date: c.date, close: c.close }));
    },
  };
}
