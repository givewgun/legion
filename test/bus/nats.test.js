import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../../src/bus/nats.js';

// Minimal fake of the nats connection surface createBus depends on.
function fakeConnection() {
  const published = [];
  return {
    published,
    publish: vi.fn((subject, data) => published.push({ subject, data })),
    subscribe: vi.fn((subject, opts) => ({ subject, opts })),
    drain: vi.fn(async () => {}),
  };
}

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

describe('createBus', () => {
  it('publishes JSON-encoded payloads', () => {
    const conn = fakeConnection();
    const bus = createBus(conn);
    bus.publishJSON('legion.cycle.NVDA', { ticker: 'NVDA' });
    expect(conn.publish).toHaveBeenCalledTimes(1);
    const call = conn.publish.mock.calls[0];
    expect(call[0]).toBe('legion.cycle.NVDA');
    expect(call[1]).toEqual(enc({ ticker: 'NVDA' }));
  });

  it('decodes JSON messages to a handler via subscribeJSON', async () => {
    const conn = fakeConnection();
    const messages = [{ data: enc({ stance: 1 }) }, { data: enc({ stance: -1 }) }];
    conn.subscribe = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        for (const m of messages) yield m;
      },
    }));
    const bus = createBus(conn);
    const received = [];
    await bus.subscribeJSON('legion.vote.NVDA.1', (msg) => received.push(msg));
    expect(received).toEqual([{ stance: 1 }, { stance: -1 }]);
  });

  it('delegates close to drain', async () => {
    const conn = fakeConnection();
    const bus = createBus(conn);
    await bus.close();
    expect(conn.drain).toHaveBeenCalledTimes(1);
  });
});
