// Maps a round evaluation into an emittable signal. Conviction is |S|/2
// (the [-2,2] score normalized to [0,1]). Non-converged rounds emit NO_CONSENSUS.
export function buildSignal(evalResult, { symbol, votes }) {
  const rationales = votes.map((v) => ({ agentId: v.agentId, rationale: v.rationale }));
  if (!evalResult.converged) {
    return {
      symbol,
      band: 'NO_CONSENSUS',
      conviction: 0,
      plan: { horizon: 'unknown', rationales, dispersion: evalResult.V },
    };
  }
  return {
    symbol,
    band: evalResult.band,
    conviction: Math.min(Math.abs(evalResult.S) / 2, 1),
    plan: { horizon: 'swing', rationales, score: evalResult.S, quorum: evalResult.kappa },
  };
}
