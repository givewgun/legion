// Static config for the Technical agent. weight is the domain prior w_i;
// effective weight = w_i * rho_i (rho defaults to 1.0 until Phase 4).
export const technicalConfig = {
  id: 'technical',
  weight: 1.0,
  provider: 'local',
};
