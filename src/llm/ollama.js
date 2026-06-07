// Local LLM provider backed by the Ollama HTTP API.
// fetchImpl is injectable for testing; defaults to global fetch (Node >=18).
import { createLimiter, retryAsync } from '../util/resilient.js';

// no custom dispatcher: NUM_PARALLEL=1 + shallow queue keeps waits < undici's 300s headers-timeout

// Classify errors for retry decisions.
const isTransient = (err) => {
  if (err.name === 'AbortError') return false; // timeout = box saturated; do NOT retry
  if (/Ollama request failed: (5\d\d|429)/.test(err.message)) return true; // 5xx or 429
  if (err.cause != null) return true; // transport drop with cause
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) return true; // transport drop
  return false; // 4xx and other non-transient errors
};

// Wrap raw error into an informative error for callers.
const wrapError = (err, timeoutMs) => {
  if (err.name === 'AbortError') {
    return new Error(`Ollama request timed out after ${timeoutMs}ms`);
  }
  if (err.cause != null || /fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) {
    return new Error(`Ollama request failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`);
  }
  return err; // HTTP-status error already has the right message
};

export function createOllamaProvider(
  { url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1 },
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
        body: JSON.stringify({ model, system, prompt, stream: false }),
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
