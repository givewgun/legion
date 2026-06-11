import { describe, it, expect } from 'vitest';
import { effectiveWindowHours, runSummaryOnce } from '../../src/run/summary.js';

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

describe('effectiveWindowHours', () => {
  it('keeps the base window on a regular weekday', () => {
    // Friday 18:00 EDT
    const friday = new Date('2026-06-12T22:00:00Z');
    expect(effectiveWindowHours(friday, 24, 'America/New_York')).toBe(24);
  });

  it('stretches Monday across the weekend back to the Friday digest', () => {
    // Monday 18:00 EDT
    const monday = new Date('2026-06-15T22:00:00Z');
    expect(effectiveWindowHours(monday, 24, 'America/New_York')).toBe(72);
  });

  it('decides the weekday in the cron timezone, not UTC', () => {
    // Tuesday 01:00 UTC is still Monday 21:00 EDT.
    const lateMonday = new Date('2026-06-16T01:00:00Z');
    expect(effectiveWindowHours(lateMonday, 24, 'America/New_York')).toBe(72);
    expect(effectiveWindowHours(lateMonday, 24, 'Asia/Bangkok')).toBe(24);
  });
});
