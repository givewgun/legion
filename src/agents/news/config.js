// w_i prior for the News/Catalyst agent. Slightly above 1.0: catalysts move
// price hard, but the agent is noisy, so it is not dominant.
export const newsConfig = {
  id: 'news',
  weight: 1.2,
  provider: 'local',
};
