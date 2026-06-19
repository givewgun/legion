import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

const PROVIDERS = ['local', 'gemini', 'openai'];

export function AgentConfig() {
  const [agents, setAgents] = useState([]);
  const [homePcEnabled, setHomePcEnabled] = useState(true);

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    api.getSettings().then((s) => setHomePcEnabled(s.homePcEnabled)).catch(() => {});
  }, []);

  async function toggleHomePc(next) {
    setHomePcEnabled(next);
    await api.setSettings({ homePcEnabled: next });
  }

  function update(id, patch) {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  async function save(a) {
    await api.setAgent(a.id, { provider: a.provider, model: a.model, enabled: a.enabled });
  }

  return (
    <>
      <label className="flex items-center gap-2 mb-3">
        <input
          aria-label="home-pc-enabled"
          type="checkbox"
          checked={homePcEnabled}
          onChange={(e) => toggleHomePc(e.target.checked)}
        />
        Use home PC model (falls back to Oracle when off, asleep, or busy)
      </label>
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
