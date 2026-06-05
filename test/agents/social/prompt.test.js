import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/social/prompt.js';

describe('social buildPrompt', () => {
  it('produces a social-sentiment persona and JSON contract', () => {
    const { system, prompt } = buildPrompt('NVDA', { sentiment: { score: 0.6, volume: 1200 } });
    expect(system).toMatch(/social|sentiment|crowd/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toMatch(/"rationale"/);
  });

  it('includes dissent when peers are supplied', () => {
    const { prompt } = buildPrompt(
      'MU',
      { sentiment: {} },
      '- news voted SELL (conviction 0.5): soft',
    );
    expect(prompt).toContain('prior round');
    expect(prompt).toContain('news');
  });
});
