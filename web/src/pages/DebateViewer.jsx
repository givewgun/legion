import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { fmtDate } from '../lib/format.js';
import { PageHeader } from '../ui/PageHeader.jsx';
import { Card } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { StanceFlowChart } from '../components/StanceFlowChart.jsx';
import { DebateThread } from '../components/DebateThread.jsx';
import { ConsensusGuide } from '../components/ConsensusGuide.jsx';

function StatusBadge({ status }) {
  const band = status === 'converged' ? 'BUY' : 'HOLD';
  return <Badge band={band}>{status}</Badge>;
}

export function DebateViewer() {
  const { symbol, cycleId } = useParams();
  const navigate = useNavigate();
  const [tickers, setTickers] = useState([]);
  const [query, setQuery] = useState('');
  const [cycles, setCycles] = useState([]);
  const [debate, setDebate] = useState(null);

  useEffect(() => {
    api
      .listCycleTickers()
      .then(setTickers)
      .catch(() => setTickers([]));
  }, []);

  useEffect(() => {
    if (!symbol) {
      setCycles([]);
      return;
    }
    api
      .listCycles(symbol)
      .then(setCycles)
      .catch(() => setCycles([]));
  }, [symbol]);

  useEffect(() => {
    if (!cycleId) {
      setDebate(null);
      return;
    }
    api
      .getDebate(Number(cycleId))
      .then(setDebate)
      .catch(() => setDebate(null));
  }, [cycleId]);

  const filtered = tickers.filter((t) =>
    t.symbol.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const consensusS = debate?.rounds?.length
    ? Number(debate.rounds[debate.rounds.length - 1].s_score)
    : undefined;

  return (
    <div>
      <PageHeader title="Debate" subtitle="How the agents argued their way to consensus" />
      <ConsensusGuide />

      <input
        aria-label="search-ticker"
        className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search ticker…"
      />

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-64">
          <h2 className="mb-2 text-sm font-semibold text-slate-500">Tickers with debates</h2>
          {tickers.length === 0 && <p className="text-sm text-slate-400">No debate data yet.</p>}
          {tickers.length > 0 && filtered.length === 0 && (
            <p className="text-sm text-slate-400">No ticker matches &ldquo;{query}&rdquo;.</p>
          )}
          <ul className="space-y-1">
            {filtered.map((t) => {
              const active = t.symbol === symbol;
              return (
                <li key={t.symbol}>
                  <button
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm ${
                      active ? 'bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => navigate(`/debate/${t.symbol}`)}
                  >
                    <span className="font-medium">{t.symbol}</span>
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">{fmtDate(t.latest_started_at)}</span>
                      <StatusBadge status={t.latest_status} />
                    </span>
                  </button>
                  {active && (
                    <ul className="mb-1 ml-2 border-l border-slate-200 pl-2">
                      {cycles.length === 0 && (
                        <li className="py-1 text-xs text-slate-400">No cycles.</li>
                      )}
                      {cycles.map((c) => (
                        <li key={c.id}>
                          <button
                            className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-xs ${
                              String(c.id) === String(cycleId)
                                ? 'bg-brand-500 text-white'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                            onClick={() => navigate(`/debate/${t.symbol}/${c.id}`)}
                          >
                            <span>#{c.id}</span>
                            <span
                              className={
                                String(c.id) === String(cycleId)
                                  ? 'text-brand-100'
                                  : 'text-slate-400'
                              }
                            >
                              {fmtDate(c.started_at)} · {c.status}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="min-w-0 flex-1">
          {debate ? (
            <>
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-lg font-semibold">
                  {debate.symbol} — cycle #{debate.id}
                </h2>
                <StatusBadge status={debate.status} />
              </div>
              <p className="mb-4 text-xs text-slate-400">
                Started {fmtDate(debate.started_at)}
                {debate.ended_at && <> · ended {fmtDate(debate.ended_at)}</>}
              </p>
              <Card className="mb-6 p-3">
                <StanceFlowChart rounds={debate.rounds} consensusS={consensusS} />
              </Card>
              <DebateThread rounds={debate.rounds} />
            </>
          ) : (
            <p className="text-slate-400">
              {symbol ? 'Pick a cycle to see the debate.' : 'Pick a ticker to see its debates.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
