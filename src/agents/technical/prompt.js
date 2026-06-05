import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a professional technical analyst on a multi-agent trading desk.
You judge a stock purely on price action, trend, momentum, and volatility.
You are decisive but honest about uncertainty.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Analyze ${symbol} from a technical standpoint.

Market data (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
