// w_i prior for the News/Catalyst agent. Slightly above 1.0: catalysts move
// price hard, but the agent is noisy, so it is not dominant.
// Sampling: moderate temperature — headline interpretation benefits from some
// breadth without inventing catalysts. Fixed seed decorrelates from peers.
export const newsConfig = {
  id: 'news',
  weight: 1.2,
  provider: 'local',
  options: { temperature: 0.6, seed: 23 },
};
