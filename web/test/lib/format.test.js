import { describe, it, expect } from 'vitest';
import { pct, stanceLabel, bandColor } from '../../src/lib/format.js';

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
});
