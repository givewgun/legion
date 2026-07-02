async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status}`);
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${method} ${path} failed: ${res.status}`);
  return res.json();
}

// Like get(), but returns null on 401 so callers can treat "not logged in" as
// a value rather than an exception.
async function getOrNull(path) {
  const res = await fetch(path);
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  listTickers: () => get('/api/tickers'),
  addTicker: (symbol) => send('POST', '/api/tickers', { symbol }),
  setTicker: (symbol, enabled) => send('PATCH', `/api/tickers/${symbol}`, { enabled }),
  listCycleTickers: () => get('/api/cycles/tickers'),
  listCycles: (symbol) => get(`/api/cycles?symbol=${encodeURIComponent(symbol)}`),
  getDebate: (id) => get(`/api/cycles/${id}`),
  listSignals: (symbol) =>
    get(symbol ? `/api/signals?symbol=${encodeURIComponent(symbol)}` : '/api/signals'),
  getReliability: () => get('/api/reliability'),
  getBacktest: (symbol) =>
    get(symbol ? `/api/backtest?symbol=${encodeURIComponent(symbol)}` : '/api/backtest'),
  getPortfolio: () => get('/api/portfolio'),
  getHoldings: () => get('/api/holdings'),
  getSizing: () => get('/api/holdings/sizing'),
  saveHolding: (ticker, body) => send('PUT', `/api/holdings/${ticker}`, body),
  deleteHolding: (ticker) => send('DELETE', `/api/holdings/${ticker}`),
  listAgents: () => get('/api/agents'),
  setAgent: (id, cfg) => send('PATCH', `/api/agents/${id}`, cfg),
  getMe: () => getOrNull('/api/auth/me'),
  logout: () =>
    fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' } }),
  getWatchlist: () => get('/api/watchlist'),
  addToWatchlist: (symbol) => send('PUT', `/api/watchlist/${symbol}`, {}),
  removeFromWatchlist: (symbol) => send('DELETE', `/api/watchlist/${symbol}`),
  triggerAllCycles: () => send('POST', '/api/trigger', {}),
  stopAllCycles: () => send('DELETE', '/api/trigger'),
  triggerTicker: (symbol) => send('POST', `/api/trigger/${symbol}`, {}),
  stopTicker: (symbol) => send('DELETE', `/api/trigger/${symbol}`),
  relearnReliability: () => send('POST', '/api/reliability/relearn', {}),
  resetReliability: () => send('POST', '/api/reliability/reset', {}),
  getSettings: () => get('/api/settings'),
  setSettings: (body) => send('PUT', '/api/settings', body),
  getPcModels: () => get('/api/settings/pc-models'),
  getOracleModels: () => get('/api/settings/oracle-models'),
};
