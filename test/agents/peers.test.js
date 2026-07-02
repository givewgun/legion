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

  it("quotes a peer's reasoning trace under its vote line", () => {
    const votes = [
      {
        agentId: 'news',
        stance: -1,
        conviction: 0.6,
        weight: 1,
        rationale: 'overvalued',
        thought: 'P/E is 3x the sector median.\nGuidance implies deceleration.',
      },
      { agentId: 'social', stance: 1, conviction: 0.3, weight: 1, rationale: 'hype' },
    ];
    const text = summarizePeers(votes, 'technical');
    expect(text).toContain('Their reasoning:');
    expect(text).toContain('P/E is 3x the sector median.');
    // multi-line thoughts stay indented under the peer's bullet
    expect(text).toContain('\n    Guidance implies deceleration.');
    // a peer without a thought keeps the plain one-line format
    expect(text).toContain('- social voted BUY (conviction 0.3): hype');
    expect(text.split('Their reasoning:').length - 1).toBe(1);
  });

  it('truncates an oversized peer thought before sharing it', () => {
    const votes = [
      {
        agentId: 'news',
        stance: 0,
        conviction: 0.5,
        weight: 1,
        rationale: 'r',
        thought: 'x'.repeat(5000),
      },
    ];
    const text = summarizePeers(votes, 'technical');
    expect(text).toContain('… [truncated]');
    expect(text.length).toBeLessThan(1200);
  });
});
