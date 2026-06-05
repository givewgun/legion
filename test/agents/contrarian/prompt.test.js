import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/contrarian/prompt.js';

describe('contrarian buildPrompt', () => {
  it('produces a contrarian persona that names the real positioning feeds', () => {
    const { system, prompt } = buildPrompt('NVDA', {
      sentiment: { score: 0.9 },
      fearGreed: { value: 80 },
      vix: 13,
      putCall: { ratio: 0.6 },
      aaii: null,
      naaim: null,
      shortInterest: { shortInterest: 1000 },
    });
    expect(system).toMatch(/contrarian|fade|devil/i);
    expect(system).toMatch(/put\/call|fear|short interest/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toMatch(/"stance"/);
  });

  it('tolerates null feed fields and notes nulls mean unavailable', () => {
    const { prompt } = buildPrompt('MU', {
      sentiment: {},
      fearGreed: null,
      vix: null,
      putCall: null,
      aaii: null,
      naaim: null,
      shortInterest: null,
    });
    expect(prompt).toMatch(/null/i);
    expect(prompt).toContain('MU');
  });

  it('foregrounds peer dissent so it can argue against the forming consensus', () => {
    const { prompt } = buildPrompt(
      'MU',
      { sentiment: {} },
      '- technical voted STRONG_BUY (conviction 0.9): breakout',
    );
    expect(prompt).toContain('prior round');
    expect(prompt).toContain('technical');
  });
});
