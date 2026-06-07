import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { pct, timeAgo } from '../lib/format.js';
import { summarize, sortSignals } from '../lib/signals.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { StatTile } from '../ui/StatTile.jsx';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { ConvictionBar } from '../ui/ConvictionBar.jsx';

const COLUMNS = [
  { key: 'symbol', label: 'Ticker' },
  { key: 'band', label: 'Band' },
  { key: 'conviction', label: 'Conviction' },
  { key: 'created_at', label: 'Age' },
];

export function SignalFeed() {
  const [signals, setSignals] = useState([]);
  const [error, setError] = useState(null);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const navigate = useNavigate();

  useEffect(() => {
    api
      .listSignals()
      .then(setSignals)
      .catch((e) => setError(e.message));
  }, []);

  function toggleSort(key) {
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  if (error) return <p className="text-red-600">{error}</p>;

  const summary = summarize(signals);
  const rows = sortSignals(signals, sort.key, sort.dir);

  return (
    <div>
      <PageHeader title="Signals" subtitle="Latest consensus calls across your tickers" />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Signals" value={String(summary.total)} />
        <StatTile label="Bull / Bear" value={`${summary.bull} / ${summary.bear}`} />
        <StatTile label="Avg conviction" value={pct(summary.avgConviction)} />
        <StatTile
          label="Last run"
          value={summary.lastCreatedAt ? timeAgo(summary.lastCreatedAt) : '—'}
        />
      </div>

      {signals.length === 0 ? (
        <p className="text-slate-400">No signals yet.</p>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={
                      sort.key === c.key
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                    className="px-4 py-2 font-medium text-slate-500"
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-slate-700"
                      onClick={() => toggleSort(c.key)}
                    >
                      {c.label}
                      {sort.key === c.key && <span>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.id}
                  className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                  onClick={() => navigate(`/debate/${s.symbol}`)}
                >
                  <td className="px-4 py-3 font-semibold text-slate-900" data-testid="row-symbol">
                    {s.symbol}
                  </td>
                  <td className="px-4 py-3">
                    <Badge band={s.band} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ConvictionBar value={s.conviction} band={s.band} />
                      <span className="w-10 shrink-0 text-right text-xs text-slate-500">
                        {pct(s.conviction)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500">{timeAgo(s.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
