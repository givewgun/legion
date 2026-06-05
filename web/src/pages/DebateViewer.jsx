import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { RoundCard } from '../components/RoundCard.jsx';

export function DebateViewer({ symbol }) {
  const [cycles, setCycles] = useState([]);
  const [debate, setDebate] = useState(null);

  useEffect(() => {
    if (symbol)
      api
        .listCycles(symbol)
        .then(setCycles)
        .catch(() => setCycles([]));
  }, [symbol]);

  function open(id) {
    api
      .getDebate(id)
      .then(setDebate)
      .catch(() => setDebate(null));
  }

  return (
    <div className="flex gap-6">
      <div className="w-48 shrink-0">
        <h2 className="mb-2 text-lg font-semibold">Cycles</h2>
        <ul>
          {cycles.map((c) => (
            <li key={c.id}>
              <button className="py-1 text-left text-sm hover:underline" onClick={() => open(c.id)}>
                #{c.id} · {c.status}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex-1">
        {debate ? (
          <>
            <h2 className="mb-3 text-lg font-semibold">
              {debate.symbol} — cycle #{debate.id} ({debate.status})
            </h2>
            {debate.rounds.map((r) => (
              <RoundCard key={r.round_no} round={r} />
            ))}
          </>
        ) : (
          <p className="text-slate-400">Select a cycle to see the debate.</p>
        )}
      </div>
    </div>
  );
}
