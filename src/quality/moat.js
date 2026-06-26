// LLM moat scorer: rates a company's competitive durability (pricing power,
// switching costs, network effects, scale) on [0,1]. Injectable provider +
// gunvest client; any failure returns null so the quality blend degrades to a
// neutral moat rather than blocking sizing.

const MoatRe = /MOAT:\s*([01](?:\.\d+)?)/i;

export function createMoatScorer({ provider, gunvest, logger = console }) {
  return async (symbol) => {
    try {
      const f = await gunvest.getFundamentals(symbol).catch(() => ({}));
      const sector = f?.sector ?? 'unknown';
      const prompt =
        `Rate the durable competitive moat of ${symbol} (sector: ${sector}) on a ` +
        `scale of 0 to 1, where 0 = no moat (commodity, easily disrupted) and ` +
        `1 = wide durable moat (pricing power, high switching costs, network ` +
        `effects, or scale). Reply with exactly one line: "MOAT: <score>" then a ` +
        `short reason.`;
      const reply = await provider.generate({ prompt });
      const m = MoatRe.exec(reply);
      if (!m) return null;
      const score = Number(m[1]);
      return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null;
    } catch (err) {
      logger.warn?.(`[moat] scoring failed for ${symbol}: ${err.message}`);
      return null;
    }
  };
}
