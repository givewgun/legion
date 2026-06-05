// Shared prompt fragments so every agent asks for the same JSON contract and
// renders dissent the same way.
export const RESPONSE_SPEC = `Respond with ONE JSON object and nothing else:
{
  "stance": <integer from -2 to 2: -2 STRONG_SELL, -1 SELL, 0 HOLD, 1 BUY, 2 STRONG_BUY>,
  "conviction": <number from 0 to 1>,
  "rationale": "<one or two sentences>"
}`;

// Renders the dissent section for round >= 2. Empty string when no peers.
export function dissentBlock(peers) {
  if (!peers) return '';
  return `

Your peers in the prior round argued:
${peers}
Weigh their strongest opposing points honestly before re-voting.`;
}
