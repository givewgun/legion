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

export function constraintSubject(ticker, round) {
  return `${PREFIX}.constraint.${ticker.toUpperCase()}.${round}`;
}

export function constraintWildcard() {
  return `${PREFIX}.constraint.>`;
}

// Operator control: stop any in-flight cycles for a ticker. The emitter (the
// cycle-state owner) subscribes and drops its buffers + closes the DB rows.
export function stopSubject(ticker) {
  return `${PREFIX}.stop.${ticker.toUpperCase()}`;
}

export function stopWildcard() {
  return `${PREFIX}.stop.*`;
}
