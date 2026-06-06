import { computeIndicators } from './indicators.js';

// Pulls the inputs the Technical agent reasons over: the current quote plus
// indicators derived from GunVest's ~1y daily `history`. When history is empty
// (e.g. the Finnhub price fallback path), indicators come back {} and the agent
// still votes off the quote alone rather than abstaining.
export async function gather(gunvest, symbol) {
  const p = (await gunvest.getPrice(symbol.toUpperCase())) ?? {};
  const quote = {
    price: p.price,
    change: p.change,
    changePct: p.changePct,
    previousClose: p.previousClose,
    open: p.open,
    dayHigh: p.dayHigh,
    dayLow: p.dayLow,
    volume: p.volume,
    fiftyTwoWeekHigh: p.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: p.fiftyTwoWeekLow,
  };
  return { quote, indicators: computeIndicators(p.history) };
}
