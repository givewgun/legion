import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { pct, bandColor } from '../lib/format.js';

export function SignalFeed() {
  const [signals, setSignals] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .listSignals()
      .then(setSignals)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Signal feed</h2>
      {signals.length === 0 && <p className="text-slate-400">No signals yet.</p>}
      <ul>
        {signals.map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between border-b border-slate-100 py-2"
          >
            <span className="font-medium">{s.symbol}</span>
            <span className={bandColor(s.band)}>{s.band}</span>
            <span className="text-slate-500">conv {pct(s.conviction)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
