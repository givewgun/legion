import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

// Global runtime settings form, rendered from /api/settings. Each key's type drives its
// control; Save PUTs every key (its value, or null to reset to the env default). Changes
// take effect on the next cycle — no redeploy.
export function RuntimeSettings() {
  const [settings, setSettings] = useState(null); // { key: {value, source, default, type, label} }
  const [pcModels, setPcModels] = useState([]);
  const [status, setStatus] = useState('');

  useEffect(() => {
    api
      .getSettings()
      .then((r) => setSettings(r.settings))
      .catch(() => {});
    api
      .getPcModels()
      .then((r) => setPcModels(r.models ?? []))
      .catch(() => setPcModels([]));
  }, []);

  if (!settings) return null;

  function setValue(key, value) {
    setSettings((prev) => ({ ...prev, [key]: { ...prev[key], value, source: 'db' } }));
  }

  // What PUT expects for a field: '' / null → reset to the env default (null).
  function toSend(key) {
    const { value, type } = settings[key];
    if (type === 'tribool' && value === null) return null;
    if ((type === 'string' || type === 'int') && (value === '' || value === null)) return null;
    return value;
  }

  async function save() {
    setStatus('Saving…');
    const body = Object.fromEntries(Object.keys(settings).map((k) => [k, toSend(k)]));
    try {
      const r = await api.setSettings(body);
      setSettings(r.settings);
      setStatus('Saved');
    } catch {
      setStatus('Save failed');
    }
  }

  return (
    <section className="mb-4 border rounded p-3">
      <h2 className="font-semibold mb-2">Runtime settings (no redeploy)</h2>
      <div className="grid grid-cols-[220px_1fr] gap-2 items-center">
        {Object.entries(settings).map(([key, field]) => (
          <Field key={key} name={key} field={field} models={pcModels} onChange={(v) => setValue(key, v)} />
        ))}
      </div>
      <button
        aria-label="save-settings"
        onClick={save}
        className="mt-3 bg-blue-600 text-white rounded px-3 py-1"
      >
        Save
      </button>
      {status && <span className="ml-2 text-gray-500">{status}</span>}
    </section>
  );
}

function Field({ name, field, models, onChange }) {
  const { value, type, default: def, source, label } = field;
  const hint = source === 'db' ? `(env: ${String(def)})` : `(default ${String(def)})`;

  let control;
  if (type === 'bool') {
    control = (
      <input
        id={`set-${name}`}
        aria-label={name}
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  } else if (type === 'tribool') {
    const v = value === true ? 'true' : value === false ? 'false' : 'default';
    control = (
      <select
        id={`set-${name}`}
        aria-label={name}
        value={v}
        className="border rounded px-1 py-0.5"
        onChange={(e) => onChange(e.target.value === 'default' ? null : e.target.value === 'true')}
      >
        <option value="default">default</option>
        <option value="true">on</option>
        <option value="false">off</option>
      </select>
    );
  } else if (type === 'int') {
    control = (
      <input
        id={`set-${name}`}
        aria-label={name}
        type="number"
        value={value ?? ''}
        className="border rounded px-1 py-0.5 w-40"
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  } else if (name === 'home_model' && models.length > 0) {
    // Dropdown of models actually pulled on the PC; keep the current value selectable
    // even if it isn't in the list.
    const opts = !value || models.includes(value) ? models : [value, ...models];
    control = (
      <select
        id={`set-${name}`}
        aria-label={name}
        value={value ?? ''}
        className="border rounded px-1 py-0.5 w-56"
        onChange={(e) => onChange(e.target.value)}
      >
        {opts.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        id={`set-${name}`}
        aria-label={name}
        value={value ?? ''}
        className="border rounded px-1 py-0.5 w-56"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <>
      <label htmlFor={`set-${name}`} className="text-sm">
        {label} <span className="text-gray-400">{hint}</span>
      </label>
      <div>{control}</div>
    </>
  );
}
