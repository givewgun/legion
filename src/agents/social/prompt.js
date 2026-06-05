import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a social sentiment analyst on a multi-agent trading desk.
You read retail mood and message volume from StockTwits and Reddit. You know the
crowd can front-run moves but is unreliable at euphoric or panicked extremes.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Assess ${symbol} from a social sentiment standpoint.

Sentiment data (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
