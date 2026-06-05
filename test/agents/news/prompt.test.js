import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/news/prompt.js';

describe('news buildPrompt', () => {
  it('produces a catalyst persona and a JSON-bearing prompt', () => {
    const { system, prompt } = buildPrompt('NVDA', {
      news: [{ title: 'beat' }],
      macro: { vix: 14 },
    });
    expect(system).toMatch(/catalyst|news/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toMatch(/"stance"/);
    expect(prompt).toMatch(/"conviction"/);
  });

  it('includes the dissent block when peers are supplied', () => {
    const { prompt } = buildPrompt(
      'MU',
      { news: [], macro: {} },
      '- technical voted STRONG_BUY (conviction 0.9): breakout',
    );
    expect(prompt).toContain('prior round');
    expect(prompt).toContain('technical');
  });
});
