// Thin read client over the GunVest REST API. fetchImpl is injectable for tests.
export function createGunvestClient(baseUrl, fetchImpl = fetch) {
  async function get(path) {
    const res = await fetchImpl(`${baseUrl}${path}`);
    if (!res.ok) throw new Error(`GunVest API GET ${path} -> ${res.status}`);
    return res.json();
  }
  return {
    getPrice: (symbol) => get(`/api/market/${symbol.toUpperCase()}`),
    getNews: (symbol) => get(`/api/news/${symbol.toUpperCase()}`),
    getSentiment: (symbol) => get(`/api/sentiment/${symbol.toUpperCase()}`),
    getStockFearGreed: () => get(`/api/sentiment/stock/fear-greed`),
    getMacro: () => get(`/api/macro`),
  };
}
