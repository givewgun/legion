// Local LLM provider backed by the official `ollama` client, streaming.
// clientFactory is injectable for testing; defaults to a real Ollama client.
// Streaming makes the first chunk arrive quickly, so a long thinking-mode phase
// no longer trips undici's 300s headers timeout — our abort timer bounds total
// generation instead. generate returns { text, thinking } so a thinking model's
// reasoning trace can ride along with the answer (null when the model emitted
// none); callers go through normalizeGenerate, which absorbs both shapes.
import { Ollama } from 'ollama';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { createLimiter, retryAsync } from '../util/resilient.js';
import { ollamaRequest, ollamaThinkingChars } from '../instrumentation/metrics.js';

// The client awaits response HEADERS before the stream iterator (and our abort
// timer) even exists — and an Ollama box whose NUM_PARALLEL slots are all busy
// sends nothing while a request waits in its queue. With the default fetch that
// queue wait is bounded by undici's 300s headersTimeout, NOT timeoutMs: any call
// queued >5 min dies with UND_ERR_HEADERS_TIMEOUT no matter how high the config
// deadline is raised (isAbort then mislabels it with the full timeoutMs). Give
// each provider a fetch whose dispatcher stretches the headers/body timeouts to
// its own timeoutMs, so queued calls genuinely get the configured deadline.
// Dispatchers are cached per deadline: providers are rebuilt every cycle
// (getProvider), and each undici Agent owns a keep-alive socket pool.
const dispatchers = new Map();
function fetchWithDeadline(timeoutMs) {
  if (!dispatchers.has(timeoutMs)) {
    dispatchers.set(
      timeoutMs,
      new UndiciAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
    );
  }
  const dispatcher = dispatchers.get(timeoutMs);
  return (input, init) => undiciFetch(input, { ...init, dispatcher });
}

// HTTP status carried by the lib's ResponseError; 5xx/429 are worth a retry.
const isRetryableStatus = (s) => s === 429 || (s >= 500 && s <= 599);

// undici reports header/body read timeouts as `TypeError: fetch failed` with these
// cause codes — the same saturation timeout our abort guards. Treat as timeout
// (not retried; would re-load a saturated box), never as a retryable transport drop.
const TimeoutCauseCodes = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

// An abort is our own timeout firing — the box is saturated, so never retry.
const isAbort = (err) => err.name === 'AbortError' || TimeoutCauseCodes.has(err.cause?.code);

// Classify errors for retry decisions.
const isTransient = (err) => {
  if (isAbort(err)) return false; // timeout = saturated; retry would re-load it
  if (err.status_code != null) return isRetryableStatus(err.status_code);
  if (/Ollama request failed: (5\d\d|429)/.test(err.message)) return true;
  if (err.cause != null) return true; // transport drop with cause
  if (/fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) return true;
  return false; // 4xx and other non-transient errors
};

// Wrap raw error into an informative error for callers (stable messages).
const wrapError = (err, timeoutMs) => {
  if (isAbort(err)) return new Error(`Ollama request timed out after ${timeoutMs}ms`);
  if (err.status_code != null) return new Error(`Ollama request failed: ${err.status_code}`);
  if (err.cause != null || /fetch failed|ECONNRESET|ECONNREFUSED|socket/i.test(err.message)) {
    return new Error(
      `Ollama request failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`,
    );
  }
  return err; // already has the right message
};

export function createOllamaProvider(
  { url, model, timeoutMs = 300000, maxConcurrent = 1, retries = 1, options = null, think = null, source = 'oracle' },
  clientFactory = (opts) => new Ollama(opts),
) {
  const client = clientFactory({ host: url, fetch: fetchWithDeadline(timeoutMs) });
  const limit = createLimiter(maxConcurrent);

  const doRequest = async ({ system, prompt }) => {
    // `options` carries per-agent sampling (temperature, seed) so agents sharing
    // one base model still sample decorrelated outputs. `think` is omitted when
    // null so a non-thinking model (qwen2.5) sees an unchanged request.
    const iterator = await client.generate({
      model,
      system,
      prompt,
      stream: true,
      ...(options && { options }),
      ...(think != null && { think }),
    });
    const timer = setTimeout(() => iterator.abort(), timeoutMs);
    let answer = '';
    let thinking = '';
    try {
      for await (const chunk of iterator) {
        if (chunk.response) answer += chunk.response;
        if (chunk.thinking) thinking += chunk.thinking;
      }
    } finally {
      clearTimeout(timer);
    }
    if (thinking) {
      ollamaThinkingChars.observe(thinking.length);
      console.debug(`[ollama] ${model} thinking: ${thinking.length} chars`);
    }
    return { text: answer, thinking: thinking || null };
  };

  return {
    name: 'local',
    model,
    source,
    async generate({ system, prompt }) {
      // Measure end-to-end generate latency (incl. queue wait + retries).
      const stop = ollamaRequest.startTimer();
      try {
        return await limit(() =>
          retryAsync(() => doRequest({ system, prompt }), { retries, baseMs: 500, isTransient }),
        );
      } catch (err) {
        throw wrapError(err, timeoutMs);
      } finally {
        stop();
      }
    },
  };
}
