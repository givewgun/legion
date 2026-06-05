// News/Catalyst inputs: ticker headlines + the macro snapshot (rates, VIX).
export async function gather(gunvest, symbol) {
  const sym = symbol.toUpperCase();
  const [news, macro] = await Promise.all([gunvest.getNews(sym), gunvest.getMacro()]);
  return { news, macro };
}
