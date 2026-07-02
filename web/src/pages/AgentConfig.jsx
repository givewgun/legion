import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { RuntimeSettings } from './RuntimeSettings.jsx';

const PROVIDERS = ['local', 'gemini', 'openai'];

// Manual operations for the PoC loop: re-kick a full sweep and re-run the
// reliability learning pass without waiting for their crons. Lives on the
// config page so it sits behind the same login gate as the other knobs.
function Operations() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

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

  return (
    <section className="mb-4 border rounded p-3">
      <h2 className="font-semibold mb-2">Operations</h2>
      <div className="flex items-center gap-2">
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
          className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50"
        >
          Run all cycles
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
          className="bg-blue-600 text-white rounded px-3 py-1 disabled:opacity-50"
        >
          Relearn reliability
        </button>
        {status && <span className="text-gray-500">{status}</span>}
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
