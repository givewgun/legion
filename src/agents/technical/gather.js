// Pulls the inputs the Technical agent reasons over. Phase 1 uses price/market
// data; later phases can add indicators/history here without touching the runner.
export async function gather(gunvest, symbol) {
  return gunvest.getPrice(symbol.toUpperCase());
}
