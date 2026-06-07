import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

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
    <div className="max-w-lg">
      <PageHeader title="Ticker config" subtitle="Which symbols Legion evaluates" />
      <form onSubmit={add} className="mb-4 flex gap-2">
        <input
          aria-label="symbol"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="e.g. NVDA"
        />
        <button
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white"
          type="submit"
        >
          Add
        </button>
      </form>
      <Card className="overflow-hidden">
        <ul>
          {tickers.map((t) => (
            <li
              key={t.symbol}
              className="flex items-center justify-between border-b border-slate-100 px-4 py-2 last:border-0"
            >
              <span className="font-medium">{t.symbol}</span>
              <button
                className={t.enabled ? 'text-sm text-green-600' : 'text-sm text-slate-400'}
                onClick={() => toggle(t)}
              >
                {t.enabled ? 'enabled' : 'disabled'}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
