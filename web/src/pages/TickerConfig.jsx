import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export function TickerConfig() {
  const [tickers, setTickers] = useState([]);
  const [symbol, setSymbol] = useState('');

  function refresh() {
    api
      .listTickers()
      .then(setTickers)
      .catch(() => setTickers([]));
  }
  useEffect(refresh, []);

  async function add(e) {
    e.preventDefault();
    if (!symbol.trim()) return;
    await api.addTicker(symbol.trim());
    setSymbol('');
    refresh();
  }

  async function toggle(t) {
    await api.setTicker(t.symbol, !t.enabled);
    refresh();
  }

  return (
    <div className="max-w-md">
      <h2 className="mb-3 text-lg font-semibold">Ticker config</h2>
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input
          aria-label="symbol"
          className="flex-1 rounded border border-slate-300 px-2 py-1"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="e.g. NVDA"
        />
        <button className="rounded bg-slate-800 px-3 py-1 text-white" type="submit">
          Add
        </button>
      </form>
      <ul>
        {tickers.map((t) => (
          <li
            key={t.symbol}
            className="flex items-center justify-between border-b border-slate-100 py-2"
          >
            <span className="font-medium">{t.symbol}</span>
            <button
              className={t.enabled ? 'text-green-600' : 'text-slate-400'}
              onClick={() => toggle(t)}
            >
              {t.enabled ? 'enabled' : 'disabled'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
