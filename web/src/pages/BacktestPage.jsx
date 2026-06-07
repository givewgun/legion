import { useEffect, useState } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { api } from '../api/client.js';
import { pct } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

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
  if (rows && rows.length === 0) return <p className="text-slate-400">No backtest results yet.</p>;

  const data = (rows ?? []).map((r) => ({
    symbol: r.symbol,
    Strategy: r.pnl,
    SPY: r.spy_pnl,
    QQQ: r.qqq_pnl,
  }));

  return (
    <div>
      <PageHeader title="Backtest" subtitle="Strategy PnL vs SPY / QQQ benchmarks" />
      <Card className="mb-5 p-3">
        <div className="h-64 w-full" data-testid="backtest-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ left: -8, right: 8 }}>
              <XAxis dataKey="symbol" stroke="#94a3b8" fontSize={12} />
              <YAxis tickFormatter={(v) => pct(v)} stroke="#94a3b8" fontSize={12} />
              <Tooltip formatter={(v) => pct(v)} />
              <Legend />
              <Bar dataKey="Strategy" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              <Bar dataKey="SPY" fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="QQQ" fill="#cbd5e1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Symbol</th>
              <th className="px-4 py-2 font-medium text-slate-500">Horizon</th>
              <th className="px-4 py-2 font-medium text-slate-500">Trades</th>
              <th className="px-4 py-2 font-medium text-slate-500">Hit rate</th>
              <th className="px-4 py-2 font-medium text-slate-500">PnL</th>
              <th className="px-4 py-2 font-medium text-slate-500">SPY</th>
              <th className="px-4 py-2 font-medium text-slate-500">QQQ</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.symbol} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{r.symbol}</td>
                <td className="px-4 py-2">{r.horizon}d</td>
                <td className="px-4 py-2">{r.trades}</td>
                <td className="px-4 py-2">{pct(r.hit_rate)}</td>
                <td className="px-4 py-2">{pct(r.pnl)}</td>
                <td className="px-4 py-2 text-slate-500">{pct(r.spy_pnl)}</td>
                <td className="px-4 py-2 text-slate-500">{pct(r.qqq_pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
