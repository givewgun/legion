import { describe, it, expect } from 'vitest';
import { runSummaryOnce } from '../../src/run/summary.js';

describe('runSummaryOnce', () => {
  it('queries the window, builds a digest, and sends it', async () => {
    const queried = [];
    const sent = [];
    const repo = {
      listSignalsSince: async (since) => {
        queried.push(since);
        return [{ symbol: 'NVDA', stance: 2, conviction: 0.9 }];
      },
    };
    const telegram = async (text) => {
      sent.push(text);
    };
    const out = await runSummaryOnce({
      repo,
      telegram,
      clock: () => new Date('2026-06-04T06:00:00Z'),
      windowHours: 6,
    });
    expect(queried[0]).toBe('2026-06-04T00:00:00.000Z'); // 6h before
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/NVDA/);
    expect(out).toEqual({ sent: true, count: 1 });
  });

  it('still sends a no-signals digest on an empty window', async () => {
    const sent = [];
    const repo = { listSignalsSince: async () => [] };
    const telegram = async (text) => {
      sent.push(text);
    };
    const out = await runSummaryOnce({
      repo,
      telegram,
      clock: () => new Date('2026-06-04T06:00:00Z'),
      windowHours: 6,
    });
    expect(sent[0]).toMatch(/no signals/i);
    expect(out).toEqual({ sent: true, count: 0 });
  });
});
