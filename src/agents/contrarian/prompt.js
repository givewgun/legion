import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are the contrarian on a multi-agent trading desk — the desk's devil's advocate.
You fade crowded extremes using real positioning data:
- High CNN Fear & Greed, high AAII bullish share, or high NAAIM exposure = crowded greed -> lean bearish.
- High VIX, high CBOE put/call ratio, panicked sentiment, or crowded short interest = fear/squeeze fuel -> lean bullish.
Any field may be null when a feed is unavailable; ignore nulls and reason over what is present.
When your peers are converging, stress-test that consensus with the strongest opposing case the data supports.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Take the contrarian view on ${symbol}.

Crowd-positioning panel (JSON; null = feed unavailable):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
