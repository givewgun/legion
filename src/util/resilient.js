// Limiter + retry helpers for resilient async operations.

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

// Retry async fn with exponential backoff + jitter on transient errors.
// Total attempts = retries + 1 (e.g., retries=2 means 3 total attempts).
// isTransient(err) determines if an error is retryable.
export async function retryAsync(fn, { retries = 2, baseMs = 200, isTransient = () => true } = {}) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let lastErr;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const attemptsRemaining = retries + 1 - attempt;
      if (attemptsRemaining === 0 || !isTransient(err)) {
        throw err;
      }
      // Backoff: baseMs * 2^(attempt-1) + random jitter
      const delayMs = baseMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * baseMs);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}
