// The Contrarian is a deliberate counterweight; modest prior so it tempers,
// not dominates. Its value is dispersion and second-look, not raw direction.
// Sampling: the hottest temperature on the desk — its whole job is to diverge
// from the panel, so it gets the widest sampling. Fixed seed decorrelates it
// from peers sharing the same base model.
export const contrarianConfig = {
  id: 'contrarian',
  weight: 0.9,
  provider: 'local',
  options: { temperature: 1.0, seed: 53 },
};
