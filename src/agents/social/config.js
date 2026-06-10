// Lower prior: crowd sentiment is informative but noisy and herd-prone.
// Sampling: higher temperature — mood reading is impressionistic by nature.
// Fixed seed decorrelates from peers sharing the same base model.
export const socialConfig = {
  id: 'social',
  weight: 0.8,
  provider: 'local',
  options: { temperature: 0.8, seed: 37 },
};
