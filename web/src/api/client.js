async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API GET ${path} failed: ${res.status}`);
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${method} ${path} failed: ${res.status}`);
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
};
