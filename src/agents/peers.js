const LABEL = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

// Renders the prior round's opposing votes as a dissent block for round >= 2.
// Empty string when no peers (round 1 or single-agent), so prompts can skip it.
export function summarizePeers(priorVotes = [], selfId) {
  const others = priorVotes.filter((v) => v.agentId !== selfId);
  if (others.length === 0) return '';
  return others
    .slice()
    .sort((a, b) => b.conviction - a.conviction)
    .map(
      (v) =>
        `- ${v.agentId} voted ${LABEL[String(v.stance)]} (conviction ${v.conviction}): ${v.rationale}`,
    )
    .join('\n');
}
