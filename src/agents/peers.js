import { truncateThought } from './parse.js';

const LABEL = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

// Per-peer cap on the shared reasoning trace. Three peers' thoughts must fit a
// small local model's context alongside the market data, so each is trimmed to
// its opening — the setup and core argument — rather than passed whole.
const PeerThoughtChars = 900;

// Renders the prior round's opposing votes as a dissent block for round >= 2.
// Empty string when no peers (round 1 or single-agent), so prompts can skip it.
// A peer that exposed its reasoning trace (a thinking model) has it quoted
// under its vote, so agents argue with each other's actual logic instead of
// re-guessing it from a one-line rationale.
export function summarizePeers(priorVotes = [], selfId) {
  const others = priorVotes.filter((v) => v.agentId !== selfId);
  if (others.length === 0) return '';
  return others
    .slice()
    .sort((a, b) => b.conviction - a.conviction)
    .map((v) => {
      const line = `- ${v.agentId} voted ${LABEL[String(v.stance)]} (conviction ${v.conviction}): ${v.rationale}`;
      const thought = truncateThought(v.thought, PeerThoughtChars);
      if (!thought) return line;
      const quoted = thought.replace(/\n/g, '\n    ');
      return `${line}\n  Their reasoning:\n    ${quoted}`;
    })
    .join('\n');
}
