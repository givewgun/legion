import { RUNTIME_KEYS } from './runtime-keys.js';

// Coerce a raw text value (as stored in legion.runtime_config, or arriving on a PUT) by
// its declared type. Returns { ok, value }: ok:false means the text is invalid for the
// type — callers 400 on write, or skip-with-warning on read so one bad row can't break
// a cycle. An empty string coerces to null (used as "no override" by string/tribool).
export function coerceRuntimeValue(type, raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const s = String(raw).trim();
  switch (type) {
    case 'bool':
      if (s.toLowerCase() === 'true') return { ok: true, value: true };
      if (s.toLowerCase() === 'false') return { ok: true, value: false };
      return { ok: false };
    case 'tribool':
      if (s === '') return { ok: true, value: null };
      if (s.toLowerCase() === 'true') return { ok: true, value: true };
      if (s.toLowerCase() === 'false') return { ok: true, value: false };
      return { ok: false };
    case 'int': {
      if (s === '') return { ok: false };
      const n = Number(s);
      return Number.isInteger(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'string':
      return { ok: true, value: s };
    default:
      return { ok: false };
  }
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const parent = parts.reduce((cur, p) => cur[p], obj);
  parent[last] = value;
}

// Overlay DB overrides onto a clone of the env-derived cfg. The env value is the default;
// a present, valid override replaces it. An empty string for a string key means "no
// override" (keep env). Invalid stored values are ignored with a warning, never thrown.
export function applyRuntimeOverrides(cfg, overrides = {}, { warn = console.warn } = {}) {
  const out = structuredClone(cfg);
  for (const { key, type, cfgPath } of RUNTIME_KEYS) {
    if (!(key in overrides)) continue;
    const { ok, value } = coerceRuntimeValue(type, overrides[key]);
    if (!ok) {
      warn(`runtime_config: ignoring invalid ${key}=${JSON.stringify(overrides[key])}`);
      continue;
    }
    if (type === 'string' && (value === null || value === '')) continue; // empty = no override
    setPath(out, cfgPath, value);
  }
  return out;
}
