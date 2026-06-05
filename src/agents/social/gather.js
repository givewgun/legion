// Social inputs: crowd mood/volume from StockTwits + Reddit (via GunVest).
export async function gather(gunvest, symbol) {
  const sentiment = await gunvest.getSentiment(symbol.toUpperCase());
  return { sentiment };
}
