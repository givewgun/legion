import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { RuntimeSettings } from './RuntimeSettings.jsx';
import { BrokerConnections } from './BrokerConnections.jsx';

const PROVIDERS = ['local', 'gemini', 'openai'];

// Manual operations for the PoC loop: kick or stop cycles (all, or a chosen
// ticker) and drive the reliability loop without waiting for the crons. Lives
// on the config page so it sits behind the same login gate as the other knobs.
function Operations() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [tickers, setTickers] = useState([]);
  const [ticker, setTicker] = useState('');

  useEffect(() => {
    api
      .listTickers()
      .then((rows) => {
        const enabled = rows.filter((t) => t.enabled).map((t) => t.symbol);
        setTickers(enabled);
        setTicker(enabled[0] ?? '');
      })
      .catch(() => setTickers([]));
  }, []);

  async function run(label, action, summarize) {
    setBusy(true);
    setStatus(`${label}…`);
    try {
      setStatus(summarize(await action()));
    } catch (e) {
      setStatus(`${label} failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const cycles = (n) => `${n} cycle${n === 1 ? '' : 's'}`;
  const blue = 'bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50';
  const red = 'bg-red-600 text-white rounded px-3 py-1 disabled:opacity-50';

  return (
    <section className="mb-4 border rounded p-3">
      <h2 className="font-semibold mb-2">Operations</h2>
      <div className="flex flex-wrap items-center gap-2">
        <button
          aria-label="run-all-cycles"
          disabled={busy}
          onClick={() =>
            run(
              'Running all cycles',
              api.triggerAllCycles,
              (r) => `Kicked ${r.kicked.length} ticker${r.kicked.length === 1 ? '' : 's'}`,
            )
          }
          className={blue}
        >
          Run all cycles
        </button>
        <button
          aria-label="stop-all-cycles"
          disabled={busy}
          onClick={() =>
            run('Stopping all cycles', api.stopAllCycles, (r) => `Stopping ${cycles(r.stopping.length)}`)
          }
          className={red}
        >
          Stop all cycles
        </button>
        <button
          aria-label="relearn-reliability"
          disabled={busy}
          onClick={() =>
            run(
              'Relearning',
              api.relearnReliability,
              (r) =>
                `Relearned: ${r.resolved} signal${r.resolved === 1 ? '' : 's'} resolved, ` +
                `${r.agents} agent dial${r.agents === 1 ? '' : 's'} recomputed`,
            )
          }
          className={blue}
        >
          Relearn reliability
        </button>
        <button
          aria-label="reset-reliability"
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                'Reset ALL reliability data? Every dial returns to neutral 1.0 and the ' +
                  'graded per-agent forecast history is deleted (signals and backtest are kept). ' +
                  'This cannot be undone.',
              )
            )
              return;
            run(
              'Resetting reliability',
              api.resetReliability,
              (r) =>
                `Reliability reset to 1.0 (${Object.values(r.cleared).reduce((a, b) => a + b, 0)} rows cleared)`,
            );
          }}
          className={red}
        >
          Reset reliability
        </button>
        {status && <span className="text-gray-500">{status}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select
          aria-label="ticker-select"
          value={ticker}
          disabled={tickers.length === 0}
          onChange={(e) => setTicker(e.target.value)}
          className="border rounded px-1 py-0.5"
        >
          {tickers.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          aria-label="run-ticker"
          disabled={busy || !ticker}
          onClick={() =>
            run(`Running ${ticker}`, () => api.triggerTicker(ticker), (r) => `Kicked ${r.symbol} (cycle ${r.cycleId})`)
          }
          className={blue}
        >
          Run cycle
        </button>
        <button
          aria-label="stop-ticker"
          disabled={busy || !ticker}
          onClick={() =>
            run(
              `Stopping ${ticker}`,
              () => api.stopTicker(ticker),
              (r) => `Stopping ${cycles(r.stopping.length)} for ${r.symbol}`,
            )
          }
          className={red}
        >
          Stop cycle
        </button>
      </div>
    </section>
  );
}

export function AgentConfig() {
  const [agents, setAgents] = useState([]);

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  function update(id, patch) {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  async function save(a) {
    await api.setAgent(a.id, { provider: a.provider, model: a.model, enabled: a.enabled });
  }

  return (
    <>
      <Operations />
      <RuntimeSettings />
      <BrokerConnections />
      <table className="w-full text-left">
      <thead>
        <tr className="border-b">
          <th className="p-2">Agent</th>
          <th className="p-2">Weight</th>
          <th className="p-2">Provider</th>
          <th className="p-2">Model</th>
          <th className="p-2">Enabled</th>
          <th className="p-2"></th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.id} className="border-b">
            <td className="p-2 font-medium">{a.id}</td>
            <td className="p-2 text-gray-500">{a.weight}</td>
            <td className="p-2">
              <select
                aria-label={`provider-${a.id}`}
                value={a.provider}
                onChange={(e) => update(a.id, { provider: e.target.value })}
                className="border rounded px-1 py-0.5"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </td>
            <td className="p-2">
              <input
                aria-label={`model-${a.id}`}
                value={a.model ?? ''}
                placeholder="(default)"
                onChange={(e) => update(a.id, { model: e.target.value || null })}
                className="border rounded px-1 py-0.5 w-40"
              />
            </td>
            <td className="p-2">
              <input
                aria-label={`enabled-${a.id}`}
                type="checkbox"
                checked={a.enabled}
                onChange={(e) => update(a.id, { enabled: e.target.checked })}
              />
            </td>
            <td className="p-2">
              <button
                aria-label={`save-${a.id}`}
                onClick={() => save(a)}
                className="bg-blue-600 text-white rounded px-2 py-0.5"
              >
                Save
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}
