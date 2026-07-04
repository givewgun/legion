import { useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { api } from '../api/client.js';
import { pct, bandColor, fmtDate } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

const money = (v) => `$${Math.round(v ?? 0).toLocaleString('en-US')}`;
// Returns are small (often < 1%) — show 2 decimals so they don't flatten to 0%.
const signedPct = (v) => `${v > 0 ? '+' : ''}${pct(v, 2)}`;
const gainColor = (v) => ((v ?? 0) >= 0 ? 'text-green-600' : 'text-red-600');

function GatewayChip({ gateway }) {
  const ok = gateway?.configured && gateway?.authenticated;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-green-500' : 'bg-red-500'}`} />
      {ok
        ? `Gateway: ${gateway.accountId}`
        : gateway?.configured
          ? 'Gateway: down'
          : 'Gateway: not configured'}
    </span>
  );
}

const StatusStyles = {
  filled: 'bg-green-100 text-green-700',
  submitted: 'bg-blue-100 text-blue-700',
  pending: 'bg-slate-100 text-slate-600',
  skipped: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
};

function StatusChip({ order }) {
  const detail = order.skipReason ?? order.error;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${StatusStyles[order.status] ?? StatusStyles.pending}`}
    >
      {order.status}
      {detail ? ` · ${detail}` : ''}
    </span>
  );
}

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
  if (!data) return <p className="text-slate-400">Loading paper trading data…</p>;

  const { gateway, curve = [], positions = [], orders = [], stats = {} } = data;

  if (curve.length === 0 && orders.length === 0)
    return <p className="text-slate-400">No paper trades yet — enable trading in Settings.</p>;

  const totalReturn = stats.totalReturn ?? 0;
  const spyReturn = stats.spyReturn ?? 0;
  const qqqReturn = stats.qqqReturn ?? 0;

  return (
    <div>
      <PageHeader
        title="Paper Trading"
        subtitle="Live IBKR paper account driven by Legion signals"
        actions={<GatewayChip gateway={gateway} />}
      />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Equity" value={money(stats.equity)} />
        <Stat label="Cash" value={money(stats.cash)} />
        <Stat label="Total return" value={signedPct(totalReturn)} accent={gainColor(totalReturn)} />
        <Stat
          label="vs SPY"
          value={signedPct(totalReturn - spyReturn)}
          accent={gainColor(totalReturn - spyReturn)}
        />
        <Stat
          label="vs QQQ"
          value={signedPct(totalReturn - qqqReturn)}
          accent={gainColor(totalReturn - qqqReturn)}
        />
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
              {['Symbol', 'Qty', 'Avg cost → Mark', 'Market value', 'Unrealized'].map((h) => (
                <th key={h} className="px-4 py-2 font-medium text-slate-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.symbol} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{p.symbol}</td>
                <td className="px-4 py-2">{p.qty.toFixed(2)}</td>
                <td className="px-4 py-2">{`$${p.avgCost.toFixed(2)} → $${p.markPrice.toFixed(2)}`}</td>
                <td className="px-4 py-2">{money(p.marketValue)}</td>
                <td className={`px-4 py-2 ${gainColor(p.unrealizedPnl)}`}>
                  {`${money(p.unrealizedPnl)} (${signedPct(p.unrealizedPnlPct)})`}
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
              {['Time', 'Symbol', 'Band', 'Qty', 'Fill', 'Status'].map((h) => (
                <th key={h} className="px-4 py-2 font-medium text-slate-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 text-slate-500">{fmtDate(o.createdAt)}</td>
                <td className="px-4 py-2 font-medium">{o.symbol}</td>
                <td className={`px-4 py-2 ${bandColor(o.band)}`}>{o.band}</td>
                <td className="px-4 py-2">{o.submittedQty ?? '—'}</td>
                <td className="px-4 py-2">
                  {o.fillQty && o.fillPrice ? `${o.fillQty} @ $${o.fillPrice.toFixed(2)}` : '—'}
                </td>
                <td className="px-4 py-2">
                  <StatusChip order={o} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
