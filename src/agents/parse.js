import { createVote, validateVote } from '../consensus/vote.js';

// Returns the balanced { ... } substring starting at `start`, or null if it
// never closes. String-aware so braces inside quoted values are not counted.
function sliceBalanced(text, start) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// Extracts the first parseable JSON object from arbitrary LLM text (tolerates
// code fences, surrounding prose, and trailing braces), maps it to a full vote,
// and validates it. A greedy regex would over-grab to the last brace, so we
// scan candidate objects from each '{' and return the first that parses.
function extractJson(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const candidate = sliceBalanced(text, start);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // not valid JSON from this brace — try the next one
    }
  }
  return null;
}

export function parseVote(text, { agentId, weight, model = null, source = null }) {
  const obj = extractJson(text);
  if (!obj) return { ok: false, vote: null, errors: ['no JSON object found in LLM output'] };

  const vote = createVote({
    agentId,
    stance: obj.stance,
    conviction: obj.conviction,
    weight,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    model,
    source,
  });

  const { ok, errors } = validateVote(vote);
  return { ok, vote: ok ? vote : null, errors };
}
