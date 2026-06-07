import { describe, it, expect, vi } from 'vitest';
import { createLimiter, retryAsync } from '../../src/util/resilient.js';

describe('createLimiter', () => {
  it('resolves with fn result value', async () => {
    const limiter = createLimiter(2);
    const result = await limiter(async () => 'success');
    expect(result).toBe('success');
  });

  it('rejects with fn error', async () => {
    const limiter = createLimiter(2);
    const err = new Error('boom');
    await expect(limiter(async () => { throw err; })).rejects.toThrow('boom');
  });

  it('limits concurrent invocations to max', async () => {
    const limiter = createLimiter(2);
    let inFlight = 0;
    let peak = 0;

    const fn = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
    };

    // Fire 8 concurrent runs
    const promises = Array(8).fill(null).map(() => limiter(fn));
    await Promise.all(promises);

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('processes queued calls when slots free', async () => {
    const limiter = createLimiter(1);
    const callOrder = [];

    const mkFn = (id) => async () => {
      callOrder.push(`${id}-start`);
      await new Promise(r => setTimeout(r, 5));
      callOrder.push(`${id}-end`);
    };

    const p1 = limiter(mkFn(1));
    const p2 = limiter(mkFn(2));
    const p3 = limiter(mkFn(3));

    await Promise.all([p1, p2, p3]);

    // With max=1, calls should be serialized: 1 starts, then 1 ends, then 2 starts, etc.
    expect(callOrder).toEqual(['1-start', '1-end', '2-start', '2-end', '3-start', '3-end']);
  });
});

describe('retryAsync', () => {
  it('succeeds on first attempt if no error', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await retryAsync(fn, { retries: 2, baseMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors and succeeds', async () => {
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length < 3) throw new Error('transient');
      return 'ok';
    });
    const result = await retryAsync(fn, { retries: 3, baseMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausts retries and rethrows last error', async () => {
    const fn = vi.fn(async () => { throw new Error('boom'); });
    await expect(retryAsync(fn, { retries: 2, baseMs: 1 }))
      .rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3); // retries=2 means 1 + 2 attempts
  });

  it('skips retry if isTransient returns false', async () => {
    const fn = vi.fn(async () => { throw new Error('nope'); });
    await expect(retryAsync(fn, { retries: 3, baseMs: 1, isTransient: () => false }))
      .rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1); // no retry
  });

  it('applies exponential backoff with jitter', async () => {
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length < 3) throw new Error('transient');
      return 'ok';
    });
    const baseMs = 10;
    const start = Date.now();
    await retryAsync(fn, { retries: 2, baseMs });
    const elapsed = Date.now() - start;

    // Expect at least 2 backoff delays:
    // 1st: baseMs * 2^0 + jitter = 10 + [0, 10)
    // 2nd: baseMs * 2^1 + jitter = 20 + [0, 10)
    // Total expected >= 30ms (rough estimate, accounting for some variance)
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it('uses custom isTransient predicate', async () => {
    const transientErrs = new Set(['ECONNREFUSED', 'ECONNRESET']);
    const isTransient = (err) => transientErrs.has(err.code);

    const fn = vi.fn(async () => {
      const err = new Error('network issue');
      err.code = 'ECONNREFUSED';
      throw err;
    });

    await expect(retryAsync(fn, { retries: 2, baseMs: 1, isTransient }))
      .rejects.toThrow('network issue');
    expect(fn).toHaveBeenCalledTimes(3); // retried
  });
});
