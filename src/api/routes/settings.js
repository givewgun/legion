import { Router } from 'express';
import { RUNTIME_KEYS, RUNTIME_KEY_BY_NAME } from '../../config/runtime-keys.js';
import { coerceRuntimeValue } from '../../config/runtime-overrides.js';

// The model lists are one-off UI fetches, not the per-cycle readiness probe, so they
// get their own, more generous deadline: a slow first /api/tags over Tailscale shouldn't
// collapse the model dropdown to a free-text box. Overridable via cfg.home.pcModelsTimeoutMs.
const ModelListTimeoutMs = 5000;

// Resolve a dotted cfgPath against the env-derived cfg (the default for each key).
function cfgDefault(cfg, path) {
  return path.split('.').reduce((cur, p) => (cur == null ? undefined : cur[p]), cfg);
}

// Effective settings map: per key, the coerced DB override when a row exists else the
// env default, plus `source` and `default` so the UI can render the current value and
// "(env: …)" hint and a reset.
function effectiveSettings(cfg, overrides) {
  const out = {};
  for (const { key, type, cfgPath, label } of RUNTIME_KEYS) {
    const def = cfgDefault(cfg, cfgPath);
    const hasRow = key in overrides;
    const coerced = hasRow ? coerceRuntimeValue(type, overrides[key]) : null;
    const fromDb = !!coerced?.ok;
    const value = fromDb ? coerced.value : def;
    // 'db' only when the row actually produced the effective value; a row that fails
    // coercion falls back to the env default, so it's reported as 'default'.
    out[key] = { value, source: fromDb ? 'db' : 'default', default: def, type, label };
  }
  return out;
}

// Global runtime settings editable from the dashboard. Each key in RUNTIME_KEYS maps to
// a config knob overlaid per cycle (model, fallback, toggle, timeouts) — a change takes
// effect next cycle with no redeploy. `cfg` is the env-derived config (for defaults +
// the home-PC URL); `fetchImpl` is injectable for tests.
export function settingsRoutes(repo, cfg = {}, fetchImpl = fetch) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ settings: effectiveSettings(cfg, await repo.getRuntimeConfig()) });
    } catch (err) {
      next(err);
    }
  });

  router.put('/', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const keys = Object.keys(body);
      // Validate the whole batch before writing anything.
      for (const k of keys) {
        const desc = RUNTIME_KEY_BY_NAME[k];
        if (!desc) return res.status(400).json({ error: `unknown setting: ${k}` });
        const v = body[k];
        if (v === null || v === '') continue; // reset to default
        if (!coerceRuntimeValue(desc.type, v).ok) {
          return res.status(400).json({ error: `invalid value for ${k}` });
        }
      }
      for (const k of keys) {
        const v = body[k];
        if (v === null || v === '') await repo.deleteRuntimeConfig(k);
        else await repo.setRuntimeConfig(k, v);
      }
      res.json({ settings: effectiveSettings(cfg, await repo.getRuntimeConfig()) });
    } catch (err) {
      next(err);
    }
  });

  // Models pulled on an Ollama box (/api/tags — the PC sidecar proxies the same
  // path), for the model dropdowns. Fail-soft: no URL / unreachable / asleep /
  // busy 503 → empty list, so the UI degrades to free-text rather than erroring.
  async function listModels(url) {
    if (!url) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.home?.pcModelsTimeoutMs ?? ModelListTimeoutMs);
    try {
      const r = await fetchImpl(`${url}/api/tags`, { signal: controller.signal });
      if (!r.ok) return [];
      const data = await r.json();
      return (data.models ?? []).map((m) => m.name).filter(Boolean);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  // Models pulled on the home PC, for the home_model dropdown.
  router.get('/pc-models', async (req, res) => {
    res.json({ models: await listModels(cfg.home?.url) });
  });

  // Models pulled on the Oracle box, for the oracle_model dropdown.
  router.get('/oracle-models', async (req, res) => {
    res.json({ models: await listModels(cfg.ollama?.url) });
  });

  return router;
}
