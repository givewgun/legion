import { describe, it, expect } from 'vitest';
import { createOllamaProvider } from '../../src/llm/ollama.js';
import { createProvider } from '../../src/llm/provider.js';

// Build a fake streaming iterator from a list of chunks. abort() makes the
// in-progress `for await` reject with an AbortError on the next tick.
function makeStream(chunks) {
  let aborted = false;
  const iterator = (async function* () {
    for (const chunk of chunks) {
      if (aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield chunk;
    }
  })();
  iterator.abort = () => {
    aborted = true;
  };
  return iterator;
}

// A stream that never yields until aborted, then throws AbortError.
function makeHangingStream() {
  let abort;
  const gate = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });
  const iterator = (async function* () {
    await gate; // never resolves; only rejects on abort
  })();
  iterator.abort = abort;
  return iterator;
}

// Factory that records the generate options and returns a scripted stream.
function fakeClientFactory(impl) {
  const calls = [];
  const factory = (opts) => ({
    init: opts,
    generate: (genOpts) => {
      calls.push(genOpts);
      return impl(genOpts, calls.length);
    },
  });
  factory.calls = calls;
  return factory;
}

describe('createOllamaProvider (official client, streaming)', () => {
  it('accumulates multi-chunk response and returns the final answer string', async () => {
    const factory = fakeClientFactory(async () =>
      makeStream([{ response: 'BUY: ' }, { response: 'trend ' }, { response: 'up' }]),
    );
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'qwen2.5:7b-instruct' },
      factory,
    );
    const out = await provider.generate({ system: 'You are a trader', prompt: 'Rate NVDA' });
    expect(out).toBe('BUY: trend up');
    const gen = factory.calls[0];
    expect(gen.model).toBe('qwen2.5:7b-instruct');
    expect(gen.system).toBe('You are a trader');
    expect(gen.prompt).toBe('Rate NVDA');
    expect(gen.stream).toBe(true);
    expect(gen.options).toBeUndefined();
    expect(gen).not.toHaveProperty('think');
  });

  it('captures thinking chunks but still returns only the answer', async () => {
    const factory = fakeClientFactory(async () =>
      makeStream([
        { thinking: 'let me reason' },
        { thinking: ' some more' },
        { response: 'HOLD' },
      ]),
    );
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'gpt-oss:20b', think: true },
      factory,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('HOLD');
    expect(factory.calls[0].think).toBe(true);
  });

  it('omits the think field when not configured', async () => {
    const factory = fakeClientFactory(async () => makeStream([{ response: 'ok' }]));
    const provider = createOllamaProvider({ url: 'http://o:11434', model: 'm' }, factory);
    await provider.generate({ system: 's', prompt: 'p' });
    expect(factory.calls[0]).not.toHaveProperty('think');
  });

  it('includes think: false when configured', async () => {
    const factory = fakeClientFactory(async () => makeStream([{ response: 'ok' }]));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', think: false },
      factory,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    expect(factory.calls[0].think).toBe(false);
  });

  it('passes per-agent sampling options (temperature, seed)', async () => {
    const factory = fakeClientFactory(async () => makeStream([{ response: 'ok' }]));
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', options: { temperature: 0.2, seed: 11 } },
      factory,
    );
    await provider.generate({ system: 's', prompt: 'p' });
    expect(factory.calls[0].options).toEqual({ temperature: 0.2, seed: 11 });
  });

  it('maps a ResponseError status to "Ollama request failed: <status>"', async () => {
    const factory = fakeClientFactory(async () => {
      throw Object.assign(new Error('server error'), {
        name: 'ResponseError',
        status_code: 500,
      });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 0 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 500',
    );
  });

  it('does NOT retry a 400 ResponseError', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { name: 'ResponseError', status_code: 400 });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 3 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(
      'Ollama request failed: 400',
    );
    expect(calls).toBe(1);
  });

  it('retries a 503 ResponseError then succeeds', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('unavailable'), {
          name: 'ResponseError',
          status_code: 503,
        });
      }
      return makeStream([{ response: 'ok after retry' }]);
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      factory,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('ok after retry');
    expect(calls).toBe(2);
  });

  it('retries a transient transport error then succeeds', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return makeStream([{ response: 'recovered' }]);
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 2, maxConcurrent: 1 },
      factory,
    );
    const out = await provider.generate({ system: 's', prompt: 'p' });
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('times out a hung stream and does NOT retry', async () => {
    let calls = 0;
    const factory = fakeClientFactory(() => {
      calls += 1;
      return makeHangingStream();
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', timeoutMs: 10, retries: 3, maxConcurrent: 1 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/i);
    expect(calls).toBe(1);
  });

  it('treats UND_ERR_HEADERS_TIMEOUT cause as a non-retried timeout', async () => {
    let calls = 0;
    const factory = fakeClientFactory(async () => {
      calls += 1;
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'UND_ERR_HEADERS_TIMEOUT' },
      });
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', retries: 3, maxConcurrent: 1 },
      factory,
    );
    await expect(provider.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/timed out/i);
    expect(calls).toBe(1);
  });

  it('hands the client a deadline-aware fetch so queue waits are not cut off at undici defaults', () => {
    const seen = [];
    const recordingFactory = (opts) => {
      seen.push(opts);
      return { generate: async () => makeStream([{ response: 'ok' }]) };
    };
    createOllamaProvider({ url: 'http://o:11434', model: 'm', timeoutMs: 3600000 }, recordingFactory);
    expect(seen[0].host).toBe('http://o:11434');
    expect(typeof seen[0].fetch).toBe('function');
  });

  it('caps concurrency: peak in-flight <= maxConcurrent', async () => {
    let inFlight = 0;
    let peak = 0;
    const factory = fakeClientFactory(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return makeStream([{ response: 'ok' }]);
    });
    const provider = createOllamaProvider(
      { url: 'http://o:11434', model: 'm', maxConcurrent: 1, retries: 0 },
      factory,
    );
    await Promise.all(
      Array.from({ length: 8 }, () => provider.generate({ system: 's', prompt: 'p' })),
    );
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe('createProvider', () => {
  it('builds an ollama provider by name', () => {
    const provider = createProvider('local', { ollama: { url: 'http://o:11434', model: 'm' } });
    expect(typeof provider.generate).toBe('function');
  });

  it('throws on an unknown provider name', () => {
    expect(() => createProvider('mystery', {})).toThrow('Unknown LLM provider: mystery');
  });
});
