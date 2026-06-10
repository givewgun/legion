import { describe, it, expect, vi } from 'vitest';
import {
  buildReflectionPrompt,
  parseLesson,
  reflectAgents,
  MIN_MISSES,
} from '../../src/reliability/reflect.js';

const miss = (symbol, stance, conviction, alpha, regime = null) => ({
  symbol,
  stance,
  conviction,
  outcome: stance > 0 ? 0 : 1,
  forward_return: alpha,
  spy_return: 0,
  regime,
});

describe('buildReflectionPrompt', () => {
  it('lists each miss with stance label, conviction, regime, and alpha', () => {
    const { system, prompt } = buildReflectionPrompt('technical', [
      miss('NVDA', 2, 0.9, -0.06, 'stressed'),
      miss('MU', 1, 0.7, -0.02),
    ]);
    expect(system).toContain('technical agent');
    expect(prompt).toContain('NVDA: STRONG_BUY at conviction 0.9 in a stressed market -> wrong (-6.0% vs SPY)');
    expect(prompt).toContain('MU: BUY at conviction 0.7 -> wrong (-2.0% vs SPY)');
    expect(prompt).toContain('ONE concrete lesson');
  });
});

describe('parseLesson', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(parseLesson('\n  Lower conviction on momentum chases.  \nextra')).toBe(
      'Lower conviction on momentum chases.',
    );
  });
  it('caps an over-long lesson', () => {
    expect(parseLesson('x'.repeat(500))).toHaveLength(300);
  });
  it('returns null for empty output', () => {
    expect(parseLesson('')).toBeNull();
    expect(parseLesson('   \n  ')).toBeNull();
    expect(parseLesson(null)).toBeNull();
  });
});

describe('reflectAgents', () => {
  const missesFor = (n) => Array.from({ length: n }, (_, i) => miss(`SYM${i}`, 1, 0.8, -0.03));

  it('writes a lesson for agents with enough misses and skips the rest', async () => {
    const lessons = [];
    const repo = {
      getAgentMisses: async (agentId) =>
        agentId === 'technical' ? missesFor(MIN_MISSES) : missesFor(MIN_MISSES - 1),
      upsertAgentLesson: async (agentId, lesson, n) => lessons.push({ agentId, lesson, n }),
    };
    const provider = { generate: vi.fn(async () => 'Avoid chasing extended momentum.') };
    const written = await reflectAgents({
      repo,
      provider,
      agentIds: ['technical', 'news'],
      logger: { error() {} },
    });
    expect(written).toBe(1);
    expect(lessons).toEqual([
      { agentId: 'technical', lesson: 'Avoid chasing extended momentum.', n: MIN_MISSES },
    ]);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it('skips an agent whose lesson is unusable and survives provider failures', async () => {
    const upserts = [];
    const repo = {
      getAgentMisses: async () => missesFor(MIN_MISSES),
      upsertAgentLesson: async (...args) => upserts.push(args),
    };
    const flaky = {
      generate: vi
        .fn()
        .mockResolvedValueOnce('') // unusable
        .mockRejectedValueOnce(new Error('ollama down')),
    };
    const written = await reflectAgents({
      repo,
      provider: flaky,
      agentIds: ['a', 'b'],
      logger: { error() {} },
    });
    expect(written).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});
