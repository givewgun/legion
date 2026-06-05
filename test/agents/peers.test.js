import { describe, it, expect } from 'vitest';
import { summarizePeers } from '../../src/agents/peers.js';

const priorVotes = [
  { agentId: 'technical', stance: 2, conviction: 0.9, weight: 1, rationale: 'breakout' },
  { agentId: 'news', stance: -1, conviction: 0.5, weight: 1, rationale: 'soft guidance' },
  { agentId: 'social', stance: 1, conviction: 0.3, weight: 1, rationale: 'mild hype' },
];

describe('summarizePeers', () => {
  it('returns empty string when there are no peers', () => {
    expect(summarizePeers([], 'technical')).toBe('');
  });

  it("excludes the agent's own prior vote", () => {
    const text = summarizePeers(priorVotes, 'technical');
    expect(text).not.toContain('technical');
    expect(text).toContain('news');
    expect(text).toContain('social');
  });

  it('orders peers by conviction descending and labels the stance', () => {
    const text = summarizePeers(priorVotes, 'contrarian');
    const firstLine = text.split('\n')[0];
    expect(firstLine).toContain('technical');
    expect(firstLine).toContain('STRONG_BUY');
    expect(text).toContain('SELL');
  });
});
