// Registry of config knobs overridable at runtime via legion.runtime_config, overlaid
// per cycle on top of the env-derived config (src/config/index.js). Single source of
// truth for coercion, API validation, and the dashboard settings form — add a knob here
// and it flows through the repo, the /api/settings contract, and the UI.
//
// `cfgPath` is the dotted location on the loaded config the override replaces; `type`
// drives coercion of the text value stored in the table. Env stays the default — a row
// here only wins when present, and deleting it reverts to env.
export const RUNTIME_KEYS = [
  { key: 'home_pc_enabled', type: 'bool', cfgPath: 'home.enabled', label: 'Use home PC model' },
  { key: 'home_model', type: 'string', cfgPath: 'home.model', label: 'Home PC model' },
  { key: 'home_fallback', type: 'bool', cfgPath: 'home.fallback', label: 'Allow Oracle fallback' },
  { key: 'home_think', type: 'tribool', cfgPath: 'home.think', label: 'Home PC reasoning (think)' },
  { key: 'home_timeout_ms', type: 'int', cfgPath: 'home.timeoutMs', label: 'Home PC call timeout (ms)' },
  {
    key: 'home_probe_timeout_ms',
    type: 'int',
    cfgPath: 'home.probeTimeoutMs',
    label: 'Home PC probe timeout (ms)',
  },
  { key: 'oracle_model', type: 'string', cfgPath: 'ollama.model', label: 'Oracle fallback model' },
  {
    key: 'oracle_timeout_ms',
    type: 'int',
    cfgPath: 'ollama.timeoutMs',
    label: 'Oracle call timeout (ms)',
  },
];

export const RUNTIME_KEY_BY_NAME = Object.fromEntries(RUNTIME_KEYS.map((k) => [k.key, k]));
