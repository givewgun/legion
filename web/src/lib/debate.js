// Pivots rounds -> a recharts-friendly series: one numeric key per agent.
export function stanceSeries(rounds = []) {
  const agentSet = new Set();
  for (const r of rounds) for (const v of r.votes ?? []) agentSet.add(v.agent_id);
  const agents = [...agentSet].sort();
  const data = rounds.map((r) => {
    const point = { round: r.round_no };
    for (const v of r.votes ?? []) point[v.agent_id] = v.stance;
    return point;
  });
  return { agents, data };
}

// Builds a per-round thread. Each message carries the agent's vote plus, for
// round >= 2, the stance delta vs that agent's previous round and the list of
// peers it saw (the prior round's other agents — what the engine feeds it).
export function threadModel(rounds = []) {
  return rounds.map((r, i) => {
    const prior = i > 0 ? rounds[i - 1] : null;
    const priorByAgent = new Map((prior?.votes ?? []).map((v) => [v.agent_id, v]));
    const messages = (r.votes ?? []).map((v) => {
      const prev = priorByAgent.get(v.agent_id);
      const delta = prev ? v.stance - prev.stance : null;
      const peers = prior
        ? (prior.votes ?? []).map((p) => p.agent_id).filter((id) => id !== v.agent_id)
        : [];
      return {
        agentId: v.agent_id,
        stance: v.stance,
        conviction: v.conviction,
        rationale: v.rationale,
        delta,
        peers,
      };
    });
    return {
      roundNo: r.round_no,
      sScore: r.s_score,
      dispersion: r.dispersion,
      quorum: r.quorum,
      converged: r.converged,
      messages,
    };
  });
}
