// Outcome-grounded agent memory (ADR 0025): before voting, an agent is shown its
// own *graded* track record — overall directional hit rate plus its most recent
// resolved calls on this ticker, each marked hit/missed with the realized alpha.
// This is the difference between turning an agent's volume knob (ρ) and letting
// the agent itself reason about having been wrong in similar spots.

const LABEL = {
  '-2': 'STRONG_SELL',
  '-1': 'SELL',
  0: 'HOLD',
  1: 'BUY',
  2: 'STRONG_BUY',
};

// Renders a fetched record into a prompt block. Empty string when there is
// nothing resolved yet — a young agent's prompt is unchanged (cold-start parity
// with every other learning mechanism).
export function formatTrackRecord({ overall, recent } = {}) {
  if (!overall || overall.total === 0) return '';
  const lines = [
    'Your verified track record (past calls graded against SPY after a fixed horizon):',
    `- Overall: ${overall.hits} of ${overall.total} directional calls beat SPY.`,
  ];
  for (const r of recent ?? []) {
    const alpha =
      r.forward_return != null && r.spy_return != null
        ? ` (${((r.forward_return - r.spy_return) * 100).toFixed(1)}% vs SPY)`
        : '';
    const hit = r.stance > 0 ? r.outcome === 1 : r.stance < 0 ? r.outcome === 0 : null;
    const verdict = hit == null ? 'no directional claim' : hit ? 'hit' : 'missed';
    lines.push(
      `- ${r.symbol}: ${LABEL[String(r.stance)]} (conviction ${r.conviction}) -> ${verdict}${alpha}`,
    );
  }
  lines.push('Weigh this record honestly when setting your stance and conviction today.');
  return lines.join('\n');
}

// Builds the per-cycle getMemory({ symbol }) callback for one agent: the graded
// track record plus, when the reflection pass has written one (ADR 0026), the
// agent's distilled lesson from its recent misses. Failures and missing repo
// support degrade to '' — memory must never block a vote.
export function buildGetMemory({ repo, agentId }) {
  return async ({ symbol }) => {
    if (!repo.getAgentTrackRecord) return '';
    const [record, lesson] = await Promise.all([
      repo.getAgentTrackRecord(agentId, symbol),
      repo.getAgentLesson?.(agentId) ?? null,
    ]);
    const parts = [formatTrackRecord(record)];
    if (lesson) parts.push(`Lesson you drew from your recent misses: ${lesson}`);
    return parts.filter(Boolean).join('\n');
  };
}
