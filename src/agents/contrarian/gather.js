// Contrarian inputs: per-ticker crowd sentiment (via GunVest) plus the market-
// wide positioning panel (F&G, VIX, put/call, AAII, NAAIM, short interest) from
// the contrarian feeds module. Each positioning field may be null when its source
// is unavailable — the agent reasons over whatever is present and ignores nulls.
export async function gather(gunvest, symbol, feeds) {
  const sym = symbol.toUpperCase();
  const [sentiment, positioning] = await Promise.all([
    gunvest.getSentiment(sym),
    feeds.gather(sym),
  ]);
  return { sentiment, ...positioning };
}
