const SYSTEM = `You are a professional technical analyst on a multi-agent trading desk.
You judge a stock purely on price action, trend, momentum, and volatility.
You are decisive but honest about uncertainty.`;

// Builds the prompt. The model must answer with a single JSON object only.
export function buildPrompt(symbol, data) {
  const prompt = `Analyze ${symbol} from a technical standpoint.

Market data (JSON):
${JSON.stringify(data, null, 2)}

Respond with ONE JSON object and nothing else:
{
  "stance": <integer from -2 to 2: -2 STRONG_SELL, -1 SELL, 0 HOLD, 1 BUY, 2 STRONG_BUY>,
  "conviction": <number from 0 to 1>,
  "rationale": "<one or two sentences>"
}`;
  return { system: SYSTEM, prompt };
}
