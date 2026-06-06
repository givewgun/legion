import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { pct } from '../lib/format.js';

export function BacktestPage() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getBacktest()
      .then(setRows)
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (rows && rows.length === 0) {
    return <p className="text-slate-400">No backtest results yet.</p>;
  }

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">Backtest</h2>
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-slate-200">
            <th className="py-2">Symbol</th>
            <th className="py-2">Horizon</th>
            <th className="py-2">Trades</th>
            <th className="py-2">Hit rate</th>
            <th className="py-2">P&amp;L</th>
            <th className="py-2">SPY</th>
            <th className="py-2">QQQ</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id} className="border-b border-slate-100">
              <td className="py-2 font-medium">{r.symbol}</td>
              <td className="py-2">{r.horizon}d</td>
              <td className="py-2">{r.trades}</td>
              <td className="py-2">{pct(r.hit_rate)}</td>
              <td className="py-2">{pct(r.pnl)}</td>
              <td className="py-2 text-slate-500">{pct(r.spy_pnl)}</td>
              <td className="py-2 text-slate-500">{pct(r.qqq_pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
