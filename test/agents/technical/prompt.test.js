import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../../src/agents/technical/prompt.js';

describe('buildPrompt', () => {
  it('produces a system persona and a data-bearing prompt', () => {
    const { system, prompt } = buildPrompt('NVDA', { price: 120, changePercent: 2.1 });
    expect(system).toMatch(/technical analyst/i);
    expect(prompt).toContain('NVDA');
    expect(prompt).toContain('120');
  });

  it('instructs the model to return strict JSON with the vote fields', () => {
    const { prompt } = buildPrompt('MU', { price: 90 });
    expect(prompt).toMatch(/"stance"/);
    expect(prompt).toMatch(/"conviction"/);
    expect(prompt).toMatch(/"rationale"/);
    expect(prompt).toMatch(/-2.*2/s); // documents the stance range
  });
});
