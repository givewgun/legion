import { createTtlCache } from '../data/feeds/cache.js';
import { computeQuality } from './score.js';

// Daily TTL: fundamentals + moat move on a daily/weekly cadence, so one fetch per
// symbol per day is plenty. gunvest caches its own Yahoo calls underneath.
const DailyTtlMs = 24 * 60 * 60 * 1000;

export function createQualityService({
  gunvest,
  moatScorer = null,
  cache = createTtlCache(),
  ttlMs = DailyTtlMs,
  logger = console,
}) {
  async function getQuality(symbol, livePrice) {
    return cache.getOrFetch(`quality:${symbol.toUpperCase()}`, ttlMs, async () => {
      const fundamentals = await gunvest.getFundamentals(symbol).catch((err) => {
        logger.warn?.(`[quality] fundamentals fetch failed for ${symbol}: ${err.message}`);
        return null;
      });
      const moat = moatScorer ? await moatScorer(symbol).catch(() => null) : null;
      // The fundamentals object carries analyst keys when gunvest exposes them.
      return computeQuality({ fundamentals, analyst: fundamentals, moat, livePrice });
    });
  }
  return { getQuality };
}
