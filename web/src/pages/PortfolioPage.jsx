import { useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { api } from '../api/client.js';
import { pct, bandColor } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

const money = (v) => `$${Math.round(v ?? 0).toLocaleString('en-US')}`;
// Returns are small (often < 1%) — show 2 decimals so they don't flatten to 0%.
const signedPct = (v) => `${v > 0 ? '+' : ''}${pct(v, 2)}`;
const gainColor = (v) => (v >= 0 ? 'text-green-600' : 'text-red-600');

function Stat({ label, value, accent = '' }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${accent}`}>{value}</p>
    </Card>
  );
}

export function PortfolioPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getPortfolio()
      .then(setData)
      .catch((e) => setError(e.message));
    const id = setInterval(() => api.getPortfolio().then(setData).catch(() => {}), 20000);
    return () => clearInterval(id);
  }, []);

  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <p className="text-slate-400">Simulating portfolio…</p>;
  if ((data.openPositions?.length ?? 0) === 0 && (data.trades?.length ?? 0) === 0)
    return <p className="text-slate-400">No signals to simulate yet.</p>;

  const { curve, trades, openPositions = [], stats } = data;

  return (
    <div>
      <PageHeader
        title="Portfolio"
        subtitle="Paper portfolio replaying every emitted signal vs SPY / QQQ buy-and-hold"
      />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <Stat
          label="Total return"
          value={signedPct(stats.totalReturn)}
          accent={gainColor(stats.totalReturn)}
        />
        <Stat
          label="vs SPY"
          value={signedPct(stats.totalReturn - stats.spyReturn)}
          accent={gainColor(stats.totalReturn - stats.spyReturn)}
        />
        <Stat
          label="vs QQQ"
          value={signedPct(stats.totalReturn - stats.qqqReturn)}
          accent={gainColor(stats.totalReturn - stats.qqqReturn)}
        />
        <Stat label="Open value" value={money(stats.openValue)} />
        <Stat label="Cash" value={money(stats.cash)} />
        <Stat label="Win rate" value={pct(stats.winRate)} />
        <Stat label="Trades" value={stats.trades} />
      </div>
      <Card className="mb-5 p-3">
        <div className="h-72 w-full" data-testid="portfolio-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={curve} margin={{ left: 8, right: 8 }}>
              <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} />
              <YAxis
                tickFormatter={money}
                stroke="#94a3b8"
                fontSize={12}
                width={80}
                domain={['auto', 'auto']}
              />
              <Tooltip formatter={(v) => money(v)} />
              <Legend />
              <Line
                type="monotone"
                dataKey="equity"
                name="Portfolio"
                stroke="#4f46e5"
                dot={false}
                strokeWidth={2}
              />
              <Line type="monotone" dataKey="spy" name="SPY" stroke="#94a3b8" dot={false} />
              <Line type="monotone" dataKey="qqq" name="QQQ" stroke="#cbd5e1" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="mb-5 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              {['Symbol', 'Shares', 'Entry → Mark', 'Unrealized'].map((h) => (
                <th key={h} className="px-4 py-2 font-medium text-slate-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {openPositions.map((p) => (
              <tr key={p.symbol} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{p.symbol}</td>
                <td className="px-4 py-2">{p.shares.toFixed(2)}</td>
                <td className="px-4 py-2">{`$${p.entryPrice.toFixed(2)} → $${p.markPrice.toFixed(2)}`}</td>
                <td className={`px-4 py-2 ${p.unrealizedReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {signedPct(p.unrealizedReturn)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              <th className="px-4 py-2 font-medium text-slate-500">Symbol</th>
              <th className="px-4 py-2 font-medium text-slate-500">Band</th>
              <th className="px-4 py-2 font-medium text-slate-500">Conviction</th>
              <th className="px-4 py-2 font-medium text-slate-500">Entry</th>
              <th className="px-4 py-2 font-medium text-slate-500">Exit</th>
              <th className="px-4 py-2 font-medium text-slate-500">Return</th>
              <th className="px-4 py-2 font-medium text-slate-500">Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr
                key={`${t.symbol}-${t.entryDate}-${i}`}
                className="border-b border-slate-100 last:border-0"
              >
                <td className="px-4 py-2 font-medium">{t.symbol}</td>
                <td className={`px-4 py-2 ${bandColor(t.band)}`}>{t.band}</td>
                <td className="px-4 py-2">{pct(t.conviction)}</td>
                <td className="px-4 py-2">{`${t.entryDate} @ $${t.entryPrice.toFixed(2)}`}</td>
                <td className="px-4 py-2">
                  {t.exitReason !== 'open' ? `$${t.exitPrice.toFixed(2)}` : '—'}
                </td>
                <td className={`px-4 py-2 ${gainColor(t.return ?? 0)}`}>
                  {signedPct(t.return ?? 0)}
                </td>
                <td className="px-4 py-2 text-slate-500">{t.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
