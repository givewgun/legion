const PREFIX = 'legion';

export function cycleSubject(ticker) {
  return `${PREFIX}.cycle.${ticker.toUpperCase()}`;
}

export function voteSubject(ticker, round) {
  return `${PREFIX}.vote.${ticker.toUpperCase()}.${round}`;
}

export function consensusSubject(ticker) {
  return `${PREFIX}.consensus.${ticker.toUpperCase()}`;
}

export function cycleWildcard() {
  return `${PREFIX}.cycle.*`;
}

export function voteWildcard() {
  return `${PREFIX}.vote.>`;
}
