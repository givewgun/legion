import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/summary/build.js';

const since = '2026-06-04T00:00:00Z';
const until = '2026-06-04T06:00:00Z';

describe('buildSummary', () => {
  it('reports a no-signals window plainly', () => {
    const text = buildSummary([], { since, until });
    expect(text).toMatch(/no signals/i);
    expect(text).toContain('06:00');
  });

  it('counts bullish, bearish, and hold signals', () => {
    const signals = [
      { symbol: 'NVDA', stance: 2, conviction: 0.9 },
      { symbol: 'MU', stance: 1, conviction: 0.6 },
      { symbol: 'INTC', stance: -1, conviction: 0.7 },
      { symbol: 'AMD', stance: 0, conviction: 0.2 },
    ];
    const text = buildSummary(signals, { since, until });
    expect(text).toMatch(/2 bullish/i);
    expect(text).toMatch(/1 bearish/i);
    expect(text).toMatch(/1 hold/i);
  });

  it('lists top calls by conviction, strongest first', () => {
    const signals = [
      { symbol: 'MU', stance: 1, conviction: 0.55 },
      { symbol: 'NVDA', stance: 2, conviction: 0.92 },
    ];
    const text = buildSummary(signals, { since, until });
    const nvdaIdx = text.indexOf('NVDA');
    const muIdx = text.indexOf('MU');
    expect(nvdaIdx).toBeGreaterThan(-1);
    expect(nvdaIdx).toBeLessThan(muIdx);
  });

  it('excludes HOLD signals from the top-calls list', () => {
    const signals = [{ symbol: 'AMD', stance: 0, conviction: 0.99 }];
    const text = buildSummary(signals, { since, until });
    expect(text).not.toMatch(/AMD .*BUY|AMD .*SELL/);
  });
});
