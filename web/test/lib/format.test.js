import { describe, it, expect } from 'vitest';
import {
  pct,
  stanceLabel,
  bandColor,
  fmtDate,
  timeAgo,
  signedDelta,
} from '../../src/lib/format.js';

describe('format helpers', () => {
  it('renders conviction as a percent', () => {
    expect(pct(0.9)).toBe('90%');
    expect(pct(0)).toBe('0%');
  });

  it('labels ordinal stances', () => {
    expect(stanceLabel(2)).toBe('STRONG_BUY');
    expect(stanceLabel(-1)).toBe('SELL');
    expect(stanceLabel(0)).toBe('HOLD');
  });

  it('maps bands to a tailwind text color', () => {
    expect(bandColor('STRONG_BUY')).toMatch(/green/);
    expect(bandColor('STRONG_SELL')).toMatch(/red/);
    expect(bandColor('NO_CONSENSUS')).toMatch(/gray|zinc|slate/);
  });

  it('formats a timestamp and tolerates nullish/invalid input', () => {
    expect(fmtDate('2026-06-03T14:30:00Z')).toMatch(/Jun/);
    expect(fmtDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
    expect(fmtDate('not-a-date')).toBe('');
  });

  it('renders a compact relative age with timeAgo', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 30 * 1000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60 * 1000).toISOString(), now)).toBe('5m');
    expect(timeAgo(new Date(now - 3 * 3600 * 1000).toISOString(), now)).toBe('3h');
    expect(timeAgo(new Date(now - 2 * 86400 * 1000).toISOString(), now)).toBe('2d');
    expect(timeAgo(null, now)).toBe('');
    expect(timeAgo('not-a-date', now)).toBe('');
  });

  it('formats a signed stance delta', () => {
    expect(signedDelta(2)).toBe('+2');
    expect(signedDelta(-1)).toBe('-1');
    expect(signedDelta(0)).toBe('0');
  });
});
