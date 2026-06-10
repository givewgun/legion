// Static config for the Technical agent. weight is the domain prior w_i;
// effective weight = w_i * rho_i (rho defaults to 1.0 until Phase 4).
// Sampling: low temperature — chart reading should be disciplined, not creative.
// A fixed per-agent seed decorrelates agents sharing one base model while
// keeping each agent's own behaviour reproducible.
export const technicalConfig = {
  id: 'technical',
  weight: 1.0,
  provider: 'local',
  options: { temperature: 0.2, seed: 11 },
};
