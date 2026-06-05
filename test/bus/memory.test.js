import { describe, it, expect, vi } from 'vitest';
import { createMemoryBus } from '../../src/bus/memory.js';

describe('createMemoryBus', () => {
  it('delivers a published message to an exact-subject subscriber', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.cycle.NVDA', handler);
    bus.publishJSON('legion.cycle.NVDA', { symbol: 'NVDA' });
    expect(handler).toHaveBeenCalledWith({ symbol: 'NVDA' });
  });

  it('matches a single-token * wildcard', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.cycle.*', handler);
    bus.publishJSON('legion.cycle.MU', { symbol: 'MU' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not match * across multiple tokens', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.cycle.*', handler);
    bus.publishJSON('legion.cycle.NVDA.1', { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('matches a trailing > wildcard across one or more tokens', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.vote.>', handler);
    bus.publishJSON('legion.vote.NVDA.1', { stance: 1 });
    bus.publishJSON('legion.vote.MU.2', { stance: -1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('isolates non-matching subjects', () => {
    const bus = createMemoryBus();
    const handler = vi.fn();
    bus.subscribeJSON('legion.vote.>', handler);
    bus.publishJSON('legion.cycle.NVDA', { x: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});
