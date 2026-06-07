import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { RoundCard } from '../components/RoundCard.jsx';
import { ConsensusGuide } from '../components/ConsensusGuide.jsx';
import { fmtDate } from '../lib/format.js';

function StatusBadge({ status }) {
  const converged = status === 'converged';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
        converged ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
      }`}
    >
      {status}
    </span>
  );
}

export function DebateViewer() {
  const [tickers, setTickers] = useState([]);
  const [query, setQuery] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [selectedCycleId, setSelectedCycleId] = useState(null);
  const [debate, setDebate] = useState(null);

  useEffect(() => {
    api
      .listCycleTickers()
      .then(setTickers)
      .catch(() => setTickers([]));
  }, []);

  function selectTicker(symbol) {
    setSelectedSymbol(symbol);
    setSelectedCycleId(null);
    setDebate(null);
    setCycles([]);
    api
      .listCycles(symbol)
      .then(setCycles)
      .catch(() => setCycles([]));
  }

  function selectCycle(id) {
    setSelectedCycleId(id);
    api
      .getDebate(id)
      .then(setDebate)
      .catch(() => setDebate(null));
  }

  const filtered = tickers.filter((t) =>
    t.symbol.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div>
      <ConsensusGuide />

      <input
        aria-label="search-ticker"
        className="mb-4 w-full rounded border border-slate-300 px-3 py-2 text-sm"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search ticker…"
      />

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 md:w-64">
          <h2 className="mb-2 text-sm font-semibold text-slate-500">Tickers with debates</h2>
          {tickers.length === 0 && <p className="text-sm text-slate-400">No debate data yet.</p>}
          {tickers.length > 0 && filtered.length === 0 && (
            <p className="text-sm text-slate-400">No ticker matches “{query}”.</p>
          )}
          <ul className="space-y-1">
            {filtered.map((t) => {
              const active = t.symbol === selectedSymbol;
              return (
                <li key={t.symbol}>
                  <button
                    className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${
                      active ? 'bg-slate-100' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => selectTicker(t.symbol)}
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
                            className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs ${
                              c.id === selectedCycleId
                                ? 'bg-slate-800 text-white'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                            onClick={() => selectCycle(c.id)}
                          >
                            <span>#{c.id}</span>
                            <span
                              className={
                                c.id === selectedCycleId ? 'text-slate-300' : 'text-slate-400'
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
              <h2 className="mb-1 text-lg font-semibold">
                {debate.symbol} — cycle #{debate.id}{' '}
                <span className="font-normal text-slate-400">({debate.status})</span>
              </h2>
              <p className="mb-3 text-xs text-slate-400">
                Started {fmtDate(debate.started_at)}
                {debate.ended_at && <> · ended {fmtDate(debate.ended_at)}</>}
              </p>
              {debate.rounds.map((r) => (
                <RoundCard key={r.round_no} round={r} />
              ))}
            </>
          ) : (
            <p className="text-slate-400">
              {selectedSymbol
                ? 'Pick a cycle to see the debate.'
                : 'Pick a ticker to see its debates.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
