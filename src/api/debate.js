// Assembles a cycle into { ...cycle, rounds: [{ ...round, votes: [...] }] }.
// Returns null for an unknown cycle so the route can 404.
export async function assembleDebate(repo, cycleId) {
  const cycle = await repo.getCycle(cycleId);
  if (!cycle) return null;

  const rounds = await repo.getRounds(cycleId);
  const withVotes = await Promise.all(
    rounds.map(async (round) => ({ ...round, votes: await repo.getVotes(round.id) })),
  );
  return { ...cycle, rounds: withVotes };
}
