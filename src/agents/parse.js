import { createVote, validateVote } from '../consensus/vote.js';

// Extracts the first JSON object from arbitrary LLM text (tolerates code
// fences / surrounding prose), maps it to a full vote, and validates it.
function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export function parseVote(text, { agentId, weight }) {
  const obj = extractJson(text);
  if (!obj) return { ok: false, vote: null, errors: ['no JSON object found in LLM output'] };

  const vote = createVote({
    agentId,
    stance: obj.stance,
    conviction: obj.conviction,
    weight,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
  });

  const { ok, errors } = validateVote(vote);
  return { ok, vote: ok ? vote : null, errors };
}
