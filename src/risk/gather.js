// Risk inputs: the day's move (chasing risk) + macro fear gauge (VIX).
export async function gatherRisk(gunvest, symbol) {
  const sym = symbol.toUpperCase();
  const [price, macro] = await Promise.all([gunvest.getPrice(sym), gunvest.getMacro()]);
  return { changePercent: price?.changePercent, vix: macro?.vix };
}
