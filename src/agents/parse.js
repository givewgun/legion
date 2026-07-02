import { createVote, validateVote } from '../consensus/vote.js';

// Thinking models running WITHOUT the structured `think` request field (e.g.
// qwen3 by default) emit their reasoning inline as <think>...</think> in the
// answer. An unterminated block (the trace ran into the token budget) is
// captured to end-of-text so a long thought is not silently lost.
const ThinkBlockRe = /<think>([\s\S]*?)(?:<\/think>|$)/gi;

// Splits inline <think> blocks out of LLM text: returns the concatenated
// reasoning (null when there is none) and the text with the blocks removed,
// so vote parsing sees only the answer.
export function splitThinking(raw) {
  const blocks = [];
  const text = raw.replace(ThinkBlockRe, (_, body) => {
    if (body.trim()) blocks.push(body.trim());
    return '';
  });
  return { thought: blocks.length > 0 ? blocks.join('\n\n') : null, text };
}

// Truncates a reasoning trace to `max` chars (head-first, with a marker) so a
// runaway thought cannot bloat the vote payload or a peer's prompt. Null-safe.
export function truncateThought(thought, max) {
  if (thought == null || thought.length <= max) return thought ?? null;
  return `${thought.slice(0, max)}… [truncated]`;
}

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

export function parseVote(text, { agentId, weight, thought = null, model = null, source = null }) {
  const obj = extractJson(text);
  if (!obj) return { ok: false, vote: null, errors: ['no JSON object found in LLM output'] };

  const vote = createVote({
    agentId,
    stance: obj.stance,
    conviction: obj.conviction,
    weight,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
    thought,
    model,
    source,
  });

  const { ok, errors } = validateVote(vote);
  return { ok, vote: ok ? vote : null, errors };
}
