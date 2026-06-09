// Limiter + retry helpers for resilient async operations.
import pRetry from 'p-retry';

// Limit concurrent invocations of async fns. Returns run(fn) directly, so callers
// invoke it as `const limit = createLimiter(n); limit(() => ...)`. Excess calls queue.
export function createLimiter(max) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
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

// Retry async fn with exponential backoff + jitter on transient errors. A thin
// adapter over p-retry (the de-facto Node retry library, built on `retry`) so we
// don't own the backoff math, while keeping a stable signature for our call sites
// and their domain-specific retry classification:
//   - retries:     number of retries (total attempts = retries + 1)
//   - baseMs:      first backoff delay; doubles each attempt (factor 2)
//   - maxDelayMs:  caps the per-attempt backoff
//   - isTransient: predicate deciding whether a thrown error is retryable
// Note: p-retry treats a non-network TypeError as a fatal bug and never retries
// it, regardless of isTransient — wrap such errors in a plain Error if you need
// them retried.
export function retryAsync(
  fn,
  { retries = 2, baseMs = 200, maxDelayMs = Infinity, isTransient = () => true } = {},
) {
  return pRetry(fn, {
    retries,
    factor: 2,
    minTimeout: baseMs,
    maxTimeout: maxDelayMs,
    randomize: true, // jitter: multiply each delay by a factor in [1, 2)
    shouldRetry: ({ error }) => isTransient(error),
  });
}
