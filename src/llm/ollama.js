// Local LLM provider backed by the Ollama HTTP API.
// fetchImpl is injectable for testing; defaults to global fetch (Node >=18).
import { createLimiter, retryAsync } from '../util/resilient.js';

// no custom dispatcher: NUM_PARALLEL=1 + shallow queue keeps waits < undici's 300s headers-timeout

// undici reports header/body read timeouts as `TypeError: fetch failed` with these
// cause codes. They are the same saturation timeout our AbortController guards (and
// undici's default 300s can win the race), so they must NOT be retried.
const TimeoutCauseCodes = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

// A saturation timeout: our own AbortController abort, or undici's read timeout.
const isTimeout = (err) => err.name === 'AbortError' || TimeoutCauseCodes.has(err.cause?.code);

// Classify errors for retry decisions.
const isTransient = (err) => {
  if (isTimeout(err)) return false; // timeout = box saturated; do NOT retry (would re-load it)
  if (/Ollama request failed: (5\d\d|429)/.test(err.message)) return true; // 5xx or 429
  if (err.cause != null) return true; // transport drop with cause
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) return true; // transport drop
  return false; // 4xx and other non-transient errors
};

// Wrap raw error into an informative error for callers.
const wrapError = (err, timeoutMs) => {
  if (isTimeout(err)) {
    return new Error(`Ollama request timed out after ${timeoutMs}ms`);
  }
  if (err.cause != null || /fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) {
    return new Error(`Ollama request failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`);
  }
  return err; // HTTP-status error already has the right message
};

export function createOllamaProvider(
  { url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1, options = null },
  fetchImpl = fetch,
) {
  const limit = createLimiter(maxConcurrent);

  const doRequest = async ({ system, prompt }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `options` carries per-agent sampling settings (temperature, seed) so
        // agents sharing one base model still sample decorrelated outputs.
        body: JSON.stringify({ model, system, prompt, stream: false, ...(options && { options }) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Ollama request failed: ${res.status}`);
      return (await res.json()).response;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: 'local',
    async generate({ system, prompt }) {
      try {
        return await limit(() =>
          retryAsync(() => doRequest({ system, prompt }), { retries, baseMs: 500, isTransient }),
        );
      } catch (err) {
        throw wrapError(err, timeoutMs);
      }
    },
  };
}
