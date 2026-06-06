import { shapeHeadlines } from './shape.js';

// News/Catalyst inputs: the ticker's recent headlines (trimmed to a lean set and
// relevance-ranked, see shape.js) plus the macro snapshot (rates, VIX). Empty
// `headlines` means the feed had nothing usable — the agent abstains with a
// clear reason rather than rambling over noise.
export async function gather(gunvest, symbol) {
  const sym = symbol.toUpperCase();
  const [news, macro] = await Promise.all([gunvest.getNews(sym), gunvest.getMacro()]);
  return { headlines: shapeHeadlines(news, sym), macro };
}
