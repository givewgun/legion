// OpenAI-compatible chat-completions provider: OpenAI itself, Gemini's
// OpenAI-compatible endpoint, or any server speaking the same protocol.
// Same generate({ system, prompt }) → string contract as the Ollama provider,
// so agents can mix model families — the real lever behind panel diversity
// (four personas on one base model share that model's blind spots).
import { createLimiter, retryAsync } from '../util/resilient.js';

// Remote API: 5xx/429 and transport drops are worth a retry; a timeout is not
// (the box isn't ours to saturate, but re-queuing a slow request just doubles
// the wait — mirror the Ollama provider's conservative stance).
const isTransient = (err) => {
  if (err.name === 'AbortError') return false;
  if (/request failed: (5\d\d|429)/.test(err.message)) return true;
  if (err.cause != null) return true;
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) return true;
  return false;
};

export function createOpenAICompatProvider(
  {
    name = 'openai',
    url,
    apiKey,
    model,
    timeoutMs = 120000,
    maxConcurrent = 2,
    retries = 1,
    options = null,
  },
  fetchImpl = fetch,
) {
  if (!apiKey) {
    throw new Error(`${name} provider requires an API key (set the provider's *_API_KEY env var)`);
  }
  const limit = createLimiter(maxConcurrent);

  const doRequest = async ({ system, prompt }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          // Per-agent sampling persona, same shape as the Ollama options block.
          ...(options?.temperature != null && { temperature: options.temperature }),
          ...(options?.seed != null && { seed: options.seed }),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${name} request failed: ${res.status}`);
      const text = (await res.json()).choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(`${name} response missing message content`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name,
    model,
    source: name,
    async generate({ system, prompt }) {
      try {
        return await limit(() =>
          retryAsync(() => doRequest({ system, prompt }), { retries, baseMs: 500, isTransient }),
        );
      } catch (err) {
        if (err.name === 'AbortError') {
          throw new Error(`${name} request timed out after ${timeoutMs}ms`);
        }
        throw err;
      }
    },
  };
}
