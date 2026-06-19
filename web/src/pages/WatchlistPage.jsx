import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

export function WatchlistPage() {
  const [symbols, setSymbols] = useState([]);
  const [roster, setRoster] = useState([]);
  const [pick, setPick] = useState('');

  useEffect(() => {
    api.getWatchlist().then((w) => setSymbols(w.symbols));
    api.listTickers().then((t) => setRoster(t.map((x) => x.symbol)));
  }, []);

  const available = roster.filter((s) => !symbols.includes(s));

  const add = async () => {
    if (!pick) return;
    const { symbols: next } = await api.addToWatchlist(pick);
    setSymbols(next);
    setPick('');
  };

  const remove = async (symbol) => {
    const { symbols: next } = await api.removeFromWatchlist(symbol);
    setSymbols(next);
  };

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Watchlist</h1>
      <ul className="mb-4 space-y-1">
        {symbols.map((s) => (
          <li key={s} className="flex items-center justify-between rounded border px-3 py-2">
            <span>{s}</span>
            <button onClick={() => remove(s)} className="text-sm text-red-600 hover:underline">
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className="rounded border px-2 py-1"
        >
          <option value="">Select a ticker…</option>
          {available.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button onClick={add} className="rounded bg-slate-900 px-3 py-1 text-white">
          Add
        </button>
      </div>
    </div>
  );
}
