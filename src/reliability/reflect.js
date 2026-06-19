// Meta-reflection (ADR 0026): on the reliability cron, each agent's recent
// *missed* calls are distilled — by an LLM — into one short lesson, persisted
// and injected into the agent's future prompts alongside its track record
// (ADR 0025). This is the gestalt editing its own reasoning: the reliability
// dials make a wrong agent quieter, the lesson tells it what to do differently.
// Disabled by default (LEGION_REFLECTION=true) — it puts an LLM in the cron.

import { normalizeGenerate } from '../llm/provider.js';

const LABEL = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

// Misses needed before a lesson is worth distilling — one bad call is noise.
export const MIN_MISSES = 3;
// Lessons are a sentence or two, not an essay; hard cap keeps prompts lean.
const MAX_LESSON_CHARS = 300;

export function buildReflectionPrompt(agentId, misses) {
  const lines = misses.map((m) => {
    const alpha =
      m.forward_return != null && m.spy_return != null
        ? ` (${((m.forward_return - m.spy_return) * 100).toFixed(1)}% vs SPY)`
        : '';
    const regime = m.regime ? ` in a ${m.regime} market` : '';
    return `- ${m.symbol}: ${LABEL[String(m.stance)]} at conviction ${m.conviction}${regime} -> wrong${alpha}`;
  });
  return {
    system:
      `You are the ${agentId} agent on a multi-agent trading desk, reviewing your own ` +
      `recent missed calls to improve. Be specific and self-critical, never defensive.`,
    prompt: `These recent calls of yours were graded wrong against SPY:
${lines.join('\n')}

State ONE concrete lesson (at most two sentences, plain text, no preamble) that would
have helped you avoid these misses. Focus on a pattern across them, not one trade.`,
  };
}

// First non-empty line of the response, capped. Null when unusable.
export function parseLesson(text) {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.slice(0, MAX_LESSON_CHARS);
}

// Distills and persists a lesson per agent with enough recent misses. Failures
// are per-agent and non-fatal — reflection is an enhancement to the cron, never
// a reason for the resolve/recompute steps to be considered failed.
export async function reflectAgents({ repo, provider, agentIds, logger = console }) {
  let written = 0;
  for (const agentId of agentIds) {
    try {
      const misses = await repo.getAgentMisses(agentId, 10);
      if (misses.length < MIN_MISSES) continue;
      const { system, prompt } = buildReflectionPrompt(agentId, misses);
      const { text } = await normalizeGenerate(provider, { system, prompt });
      const lesson = parseLesson(text);
      if (!lesson) continue;
      await repo.upsertAgentLesson(agentId, lesson, misses.length);
      written += 1;
    } catch (err) {
      logger.error(`[reflect] ${agentId} failed: ${err.message}`);
    }
  }
  return written;
}
