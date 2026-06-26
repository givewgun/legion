import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { pct } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';

const money = (v) => `$${Math.round(v ?? 0).toLocaleString('en-US')}`;
const gainColor = (v) => (v >= 0 ? 'text-green-600' : 'text-red-600');
const PollMs = 20000;

const actionColor = { buy: 'text-green-600', trim: 'text-red-600', hold: 'text-slate-500' };

export function HoldingsPage() {
  const [holdings, setHoldings] = useState([]);
  const [sizing, setSizing] = useState(null);
  const [form, setForm] = useState({ ticker: '', shares: '', avgCost: '' });
  const [error, setError] = useState(null);

  const refresh = () => {
    api.getHoldings().then((d) => setHoldings(d.holdings)).catch((e) => setError(e.message));
    api.getSizing().then(setSizing).catch((e) => setError(e.message));
  };

  useEffect(() => {
    let mounted = true;
    const load = () => {
      api.getHoldings().then((d) => { if (mounted) setHoldings(d.holdings); }).catch((e) => { if (mounted) setError(e.message); });
      api.getSizing().then((d) => { if (mounted) setSizing(d); }).catch((e) => { if (mounted) setError(e.message); });
    };
    load();
    const id = setInterval(() => api.getSizing().then((d) => { if (mounted) setSizing(d); }).catch(() => {}), PollMs);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const save = async (e) => {
    e.preventDefault();
    try {
      await api.saveHolding(form.ticker, { shares: Number(form.shares), avgCost: Number(form.avgCost) });
      setForm({ ticker: '', shares: '', avgCost: '' });
      refresh();
    } catch (err) { setError(err.message); }
  };

  const remove = async (ticker) => {
    try { await api.deleteHolding(ticker); refresh(); }
    catch (err) { setError(err.message); }
  };

  return (
    <div>
      <PageHeader title="Holdings" subtitle="Your real positions, sized by signal conviction × company quality" />
      {error && <p className="mb-3 text-red-600">{error}</p>}

      <Card className="mb-5 p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={save}>
          <label className="text-sm">Ticker
            <input className="ml-2 rounded border px-2 py-1" value={form.ticker}
              onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} required />
          </label>
          <label className="text-sm">Shares
            <input className="ml-2 w-24 rounded border px-2 py-1" type="number" step="any" value={form.shares}
              onChange={(e) => setForm({ ...form, shares: e.target.value })} required />
          </label>
          <label className="text-sm">Avg cost
            <input className="ml-2 w-28 rounded border px-2 py-1" type="number" step="any" value={form.avgCost}
              onChange={(e) => setForm({ ...form, avgCost: e.target.value })} required />
          </label>
          <button className="rounded bg-indigo-600 px-3 py-1 text-white" type="submit">Save</button>
        </form>
      </Card>

      {sizing && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Total value</p><p className="text-xl font-semibold">{money(sizing.summary.totalValue)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Unrealized P/L</p><p className={`text-xl font-semibold ${gainColor(sizing.summary.unrealizedPnl)}`}>{money(sizing.summary.unrealizedPnl)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Target invested</p><p className="text-xl font-semibold">{pct(sizing.summary.targetInvestedPct)}</p></Card>
          <Card className="p-4"><p className="text-xs uppercase text-slate-500">Positions</p><p className="text-xl font-semibold">{holdings.length}</p></Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200">
              {['Symbol', 'Now →', 'Target', 'Δ $', 'Unrealized', 'Action', ''].map((h) => (
                <th key={h} className="px-4 py-2 font-medium text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(sizing?.rows ?? []).map((r) => (
              <tr key={r.ticker} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-2 font-medium">{r.ticker}{r.flags?.length ? <span title={r.flags.join(', ')} className="ml-1 text-amber-500">⚠</span> : null}</td>
                <td className="px-4 py-2">{pct(r.currentWeight)}</td>
                <td className="px-4 py-2">{pct(r.targetWeight)}</td>
                <td className={`px-4 py-2 ${gainColor(r.deltaUSD)}`}>{money(r.deltaUSD)}</td>
                <td className={`px-4 py-2 ${gainColor(r.unrealizedPnl)}`}>{money(r.unrealizedPnl)} ({pct(r.unrealizedPnlPct, 1)})</td>
                <td className={`px-4 py-2 font-medium ${actionColor[r.action] ?? ''}`}>{r.action}</td>
                <td className="px-4 py-2"><button className="text-slate-400 hover:text-red-600" onClick={() => remove(r.ticker)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
