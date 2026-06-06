import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a professional technical analyst on a multi-agent trading desk.
You judge a stock purely on price action, trend, momentum, and volatility.
You are decisive but honest about uncertainty.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Analyze ${symbol} from a technical standpoint.

The JSON holds the latest quote plus precomputed indicators (moving averages, RSI,
trailing returns, realized volatility, distance from 52-week high/low). Reason over
the indicators; an empty indicators object means only a price snapshot is available.

Market data (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
