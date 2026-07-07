import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Broker connections (ADR 0036): dashboard-managed broker linkage. Add IBKR /
// Webull TH connections, test them, and pick which one the executor trades.
// Secret fields are write-only — the API returns masked values; leaving a
// secret blank on edit keeps the stored one.

const BrokerFields = {
  ibkr: [
    { key: 'gatewayUrl', label: 'IBeam gateway URL', placeholder: 'https://ibeam:5000/v1/api', secret: true },
  ],
  webull: [
    { key: 'appKey', label: 'App key', secret: true },
    { key: 'appSecret', label: 'App secret', secret: true },
    { key: 'accountId', label: 'Account ID (blank = sole account)' },
    { key: 'apiHost', label: 'API host override (blank = api.webull.co.th)' },
  ],
};

const EmptyForm = { name: '', broker: 'webull', paper: true, credentials: {} };

export function BrokerConnections() {
  const [connections, setConnections] = useState([]);
  const [allowLive, setAllowLive] = useState(false);
  const [form, setForm] = useState(null); // null = closed; {id?, ...EmptyForm}
  const [status, setStatus] = useState('');
  const [testResults, setTestResults] = useState({}); // id -> result

  function reload() {
    api
      .listBrokerConnections()
      .then((r) => {
        setConnections(r.connections ?? []);
        setAllowLive(!!r.allowLive);
      })
      .catch(() => setConnections([]));
  }
  useEffect(reload, []);

  async function run(label, fn) {
    setStatus(`${label}…`);
    try {
      await fn();
      setStatus('');
      reload();
    } catch (err) {
      setStatus(`${label} failed: ${err.message}`);
    }
  }

  async function test(id) {
    setTestResults((prev) => ({ ...prev, [id]: { pending: true } }));
    try {
      const r = await api.testBrokerConnection(id);
      setTestResults((prev) => ({ ...prev, [id]: r }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: err.message } }));
    }
  }

  async function save() {
    const body = {
      name: form.name,
      paper: form.paper,
      credentials: form.credentials,
      ...(form.id === undefined ? { broker: form.broker } : {}),
    };
    await run(form.id === undefined ? 'Adding' : 'Saving', () =>
      form.id === undefined ? api.addBrokerConnection(body) : api.updateBrokerConnection(form.id, body),
    );
    setForm(null);
  }

  return (
    <section className="mb-4 border rounded p-3">
      <h2 className="font-semibold mb-2">Broker connections</h2>
      <p className="text-sm text-gray-500 mb-2">
        The executor trades on the <b>active</b> connection; orders go out on the next 15s tick
        after a signal fires. Live (non-paper) connections also need{' '}
        <code>LEGION_ALLOW_LIVE_BROKER=true</code>
        {allowLive ? ' (currently set)' : ' (currently NOT set)'}.
      </p>

      {connections.length === 0 && (
        <p className="text-sm text-gray-500 mb-2">No connections yet — trading is idle.</p>
      )}
      {connections.map((c) => (
        <ConnectionRow
          key={c.id}
          conn={c}
          testResult={testResults[c.id]}
          onActivate={() => run('Activating', () => api.activateBrokerConnection(c.id))}
          onDeactivate={() => run('Deactivating', () => api.deactivateBrokerConnection())}
          onEdit={() =>
            setForm({ id: c.id, name: c.name, broker: c.broker, paper: c.paper, credentials: {} })
          }
          onDelete={() =>
            window.confirm(`Delete broker connection "${c.name}"?`) &&
            run('Deleting', () => api.deleteBrokerConnection(c.id))
          }
          onTest={() => test(c.id)}
        />
      ))}

      {form ? (
        <ConnectionForm form={form} setForm={setForm} onSave={save} onCancel={() => setForm(null)} />
      ) : (
        <button
          aria-label="add-broker-connection"
          onClick={() => setForm({ ...EmptyForm })}
          className="mt-2 bg-blue-600 text-white rounded px-3 py-1"
        >
          Add connection
        </button>
      )}
      {status && <span className="ml-2 text-gray-500">{status}</span>}
    </section>
  );
}

function ConnectionRow({ conn, testResult, onActivate, onDeactivate, onEdit, onDelete, onTest }) {
  return (
    <div className="border rounded p-2 mb-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="radio"
          aria-label={`activate-${conn.id}`}
          checked={conn.active}
          onChange={() => (conn.active ? onDeactivate() : onActivate())}
          onClick={() => conn.active && onDeactivate()}
        />
        <span className="font-medium">{conn.name}</span>
        <span className="text-xs uppercase text-gray-500">{conn.broker}</span>
        <span className={`text-xs rounded px-1 ${conn.paper ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {conn.paper ? 'paper' : 'LIVE'}
        </span>
        {conn.active && <span className="text-xs rounded px-1 bg-blue-100 text-blue-800">active</span>}
        {conn.credentialsError && (
          <span className="text-xs text-red-600">credentials unreadable — re-enter them</span>
        )}
        <span className="flex-1" />
        <button aria-label={`test-${conn.id}`} onClick={onTest} className="text-sm border rounded px-2">
          Test
        </button>
        <button aria-label={`edit-${conn.id}`} onClick={onEdit} className="text-sm border rounded px-2">
          Edit
        </button>
        <button aria-label={`delete-${conn.id}`} onClick={onDelete} className="text-sm border rounded px-2 text-red-600">
          Delete
        </button>
      </div>
      {testResult && (
        <div className="text-sm mt-1">
          {testResult.pending ? (
            <span className="text-gray-500">Testing…</span>
          ) : testResult.ok ? (
            <span className="text-green-700">
              OK — account {testResult.accountId}, equity {testResult.equity}, cash {testResult.cash}
            </span>
          ) : (
            <span className="text-red-600">Failed: {testResult.error}</span>
          )}
          {testResult.accounts?.length > 0 && (
            <div className="text-gray-500">
              Accounts:{' '}
              {testResult.accounts
                .map((a) => `${a.accountId}${a.accountType ? ` (${a.accountType})` : ''}`)
                .join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionForm({ form, setForm, onSave, onCancel }) {
  const fields = BrokerFields[form.broker] ?? [];
  const isNew = form.id === undefined;

  function setCred(key, value) {
    setForm((prev) => ({ ...prev, credentials: { ...prev.credentials, [key]: value } }));
  }

  return (
    <div className="border rounded p-2 mt-2 grid grid-cols-[220px_1fr] gap-2 items-center">
      <label className="text-sm" htmlFor="bc-name">Name</label>
      <input
        id="bc-name"
        aria-label="connection-name"
        value={form.name}
        placeholder="Webull TH — paper"
        className="border rounded px-1 py-0.5 w-72"
        onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
      />

      <label className="text-sm" htmlFor="bc-broker">Broker</label>
      {isNew ? (
        <select
          id="bc-broker"
          aria-label="connection-broker"
          value={form.broker}
          className="border rounded px-1 py-0.5 w-40"
          onChange={(e) => setForm((prev) => ({ ...prev, broker: e.target.value, credentials: {} }))}
        >
          <option value="webull">Webull</option>
          <option value="ibkr">IBKR (IBeam)</option>
        </select>
      ) : (
        <span className="text-sm uppercase">{form.broker}</span>
      )}

      <label className="text-sm" htmlFor="bc-paper">Paper account</label>
      <input
        id="bc-paper"
        aria-label="connection-paper"
        type="checkbox"
        checked={form.paper}
        onChange={(e) => setForm((prev) => ({ ...prev, paper: e.target.checked }))}
      />

      {fields.map((f) => (
        <FieldInput key={f.key} field={f} isNew={isNew} value={form.credentials[f.key] ?? ''} onChange={setCred} />
      ))}

      <div />
      <div>
        <button aria-label="save-broker-connection" onClick={onSave} className="bg-blue-600 text-white rounded px-3 py-1">
          {isNew ? 'Add' : 'Save'}
        </button>
        <button aria-label="cancel-broker-connection" onClick={onCancel} className="ml-2 border rounded px-3 py-1">
          Cancel
        </button>
      </div>
    </div>
  );
}

function FieldInput({ field, isNew, value, onChange }) {
  const placeholder = field.secret && !isNew ? 'leave blank to keep stored value' : field.placeholder ?? '';
  return (
    <>
      <label className="text-sm" htmlFor={`bc-${field.key}`}>{field.label}</label>
      <input
        id={`bc-${field.key}`}
        aria-label={`credential-${field.key}`}
        type={field.secret ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        className="border rounded px-1 py-0.5 w-72"
        onChange={(e) => onChange(field.key, e.target.value)}
      />
    </>
  );
}
