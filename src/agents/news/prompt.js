import { RESPONSE_SPEC, dissentBlock } from '../format.js';

const SYSTEM = `You are a news and catalyst analyst on a multi-agent trading desk.
You weigh breaking news, earnings, guidance, analyst actions, and the macro backdrop
(rates, risk sentiment, VIX). You care about what changes the forward narrative.`;

export function buildPrompt(symbol, data, peers = '') {
  const prompt = `Assess ${symbol} from a news and catalyst standpoint.

Headlines and macro (JSON):
${JSON.stringify(data, null, 2)}${dissentBlock(peers)}

${RESPONSE_SPEC}`;
  return { system: SYSTEM, prompt };
}
