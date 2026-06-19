import { isValidStance } from './stance.js';

export function createVote({ agentId, stance, conviction, weight, rationale, model = null }) {
  return { agentId, stance, conviction, weight, rationale, model };
}

export function validateVote(vote) {
  const errors = [];
  if (typeof vote.agentId !== 'string' || vote.agentId.length === 0) {
    errors.push('agentId must be a non-empty string');
  }
  if (!isValidStance(vote.stance)) {
    errors.push('stance must be an integer in [-2,2]');
  }
  if (typeof vote.conviction !== 'number' || vote.conviction < 0 || vote.conviction > 1) {
    errors.push('conviction must be a number in [0,1]');
  }
  if (typeof vote.weight !== 'number' || vote.weight <= 0) {
    errors.push('weight must be a positive number');
  }
  if (typeof vote.rationale !== 'string') {
    errors.push('rationale must be a string');
  }
  return { ok: errors.length === 0, errors };
}
