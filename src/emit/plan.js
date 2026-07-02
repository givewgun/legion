// Maps a round evaluation into an emittable signal. Conviction is |S|/2
// (the [-2,2] score normalized to [0,1]). Non-converged rounds emit NO_CONSENSUS.
// A degraded round (effective panel below the BFT floor — abstentions shrank it)
// is tagged on the plan so the dashboard and Telegram can show the weakened
// single-outlier guarantee instead of presenting the call as full-panel.
export function buildSignal(evalResult, { symbol, votes }) {
  const rationales = votes.map((v) => ({
    agentId: v.agentId,
    rationale: v.rationale,
    model: v.model ?? null,
    source: v.source ?? null,
  }));
  const degraded = evalResult.degraded ? { degradedQuorum: true, nEff: evalResult.nEff } : {};
  if (!evalResult.converged) {
    return {
      symbol,
      band: 'NO_CONSENSUS',
      conviction: 0,
      plan: { horizon: 'unknown', rationales, dispersion: evalResult.V, ...degraded },
    };
  }
  return {
    symbol,
    band: evalResult.band,
    conviction: Math.min(Math.abs(evalResult.S) / 2, 1),
    plan: {
      horizon: 'swing',
      rationales,
      score: evalResult.S,
      quorum: evalResult.kappa,
      ...(evalResult.A != null && { agreement: evalResult.A }),
      ...(evalResult.drift != null && { drift: evalResult.drift }),
      ...degraded,
    },
  };
}
