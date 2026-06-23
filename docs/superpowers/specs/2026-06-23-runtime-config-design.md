# Runtime config overrides (model + routing knobs, no redeploy)

**Date:** 2026-06-23
**Status:** Approved, pending implementation plan
**Branch:** `claude/runtime-config`

## Problem

Model and routing knobs for the home-PC tier (`HOME_MODEL`, `HOME_FALLBACK`,
`HOME_THINK`, `HOME_TIMEOUT_MS`, `HOME_PROBE_TIMEOUT_MS`) and the Oracle fallback
(`OLLAMA_MODEL`) are read from environment **once at boot** in `loadConfig`. Changing
any of them in production means updating a GitHub secret and triggering a full CI
redeploy — slow and heavy for a value that should be a quick flip (e.g. swapping the
PC model qwen3:14b → qwen3:8b).

Some runtime config already exists and works well:

- `legion.agent_config` — per-agent provider/model/enabled, read **per cycle** in
  `src/agents/get-provider.js`, edited on the dashboard Agents tab. No redeploy.
- `legion.runtime_config` — a key/value table holding `home_pc_enabled` (the home-PC
  kill switch), read per cycle in `get-provider.js` and overlaid as `cfg.home.enabled`,
  edited via `PUT /api/settings`.

This feature generalizes that proven per-cycle-override pattern to cover the rest of
the model/routing knobs, editable from the dashboard.

## Goals

- Change the listed knobs at runtime; effect on the **next cycle**, no redeploy, no
  secret change.
- Edit from the dashboard (settings page), with the home-PC model offered as a
  dropdown of models actually pulled on the PC.
- Env stays the **default**; a DB override wins when present; deleting the override
  reverts to env.

## Non-goals

- No mid-cycle / instant application — per-cycle read latency is acceptable.
- No PC-side control (pulling models, prime/advertise in `legion-pc.config.ps1`) from
  the dashboard. Overrides cover only the Legion/VM side: what Legion *requests*.
- No change to the per-agent `agent_config` mechanism or its quirk (a per-agent
  `model` overlays the provider's config block via `withModel`).
- No new secrets-grade values (URLs, keys) in `runtime_config`.

## Approach

Per-cycle DB overrides overlaid on the env-derived `cfg`, scoped to the provider-build
path where these knobs are consumed. Chosen over (a) polling and rebuilding the whole
`cfg` (heavier, restart-ish, touches unrelated consumers) and (b) an external config
service (overkill).

## Design

### 1. Key registry — `src/config/runtime-keys.js`

Single source of truth driving coercion, API validation, and UI rendering. An array of
descriptors:

```
{ key, envKey, type, cfgPath, label }
```

| key | envKey | type | cfgPath |
|---|---|---|---|
| `home_pc_enabled` | (n/a) | bool | `home.enabled` |
| `home_model` | HOME_MODEL | string | `home.model` |
| `home_fallback` | HOME_FALLBACK | bool | `home.fallback` |
| `home_think` | HOME_THINK | tribool | `home.think` |
| `home_timeout_ms` | HOME_TIMEOUT_MS | int | `home.timeoutMs` |
| `home_probe_timeout_ms` | HOME_PROBE_TIMEOUT_MS | int | `home.probeTimeoutMs` |
| `oracle_model` | OLLAMA_MODEL | string | `ollama.model` |

Types:
- `bool` — `'true'`/`'false'` text ↔ boolean.
- `tribool` — `'true'`/`'false'`/unset (matches the existing `bool()` helper: unset → null).
- `int` — parsed; reject NaN.
- `string` — passthrough, trimmed; empty → treated as "no override" (delete).

### 2. Repo — `src/db/repo.js`

Replace the two `home_pc_enabled`-specific helpers with generic ones:

- `getRuntimeConfig()` → `{ [key]: value }` (all rows, raw text values).
- `setRuntimeConfig(key, value)` → upsert (the existing `INSERT … ON CONFLICT` shape).
- `deleteRuntimeConfig(key)` → remove the row (reset to env default).

`home_pc_enabled` becomes just another key. No schema change — `legion.runtime_config`
already has `(key, value, updated_at)`.

### 3. Overlay — `applyRuntimeOverrides(cfg, overrides)`

Pure function (own module, unit-tested). For each registry key present in `overrides`,
coerce by type and assign to its `cfgPath` on a cloned `cfg`. Absent keys keep the env
default. Invalid stored values (shouldn't happen — validated on write) are ignored with
a warning, never throw, so a bad row can't break a cycle.

`buildGetProvider` currently does a single `getHomePcEnabled()` read per cycle and
overlays `home.enabled`. Replace with one `getRuntimeConfig()` call + `applyRuntimeOverrides`,
so every registry key applies next cycle. Precedence: **DB override > env default**.

### 4. API — `src/api/routes/settings.js`

- `GET /api/settings` → for each registry key: `{ value, source: 'db'|'default', default }`,
  where `value` is the effective value (db row coerced, else env default), `default` is
  the env-derived value. Lets the UI show current + "(env: …)".
- `PUT /api/settings` → accepts a partial `{ key: value }` map. For each: reject unknown
  keys (400) and type-invalid values (400); `null`/`''` → `deleteRuntimeConfig`; else
  coerce-validate then `setRuntimeConfig`. Returns the new effective settings (same shape
  as GET).
- `GET /api/settings/pc-models` → proxies `GET {cfg.home.url}/api/tags`, returns
  `{ models: string[] }` (names only). Fail-soft: on any error / unreachable / no
  `home.url`, return `{ models: [] }` (200) so the UI degrades to free-text.

Back-compat: the existing `homePcEnabled` GET/PUT contract is superseded by the generic
map. The web client is updated in lockstep (single repo), so no transitional shim.

### 5. UI — settings page (`web/`)

Form rendered from the registry (`GET /api/settings`):
- `home_model` — dropdown from `GET /api/settings/pc-models`; if the list is empty (PC
  down), render a free-text input instead. Current value preselected even if not in the
  list.
- `oracle_model` — text input.
- `home_pc_enabled`, `home_fallback` — checkboxes.
- `home_think` — tri-state (on / off / default).
- `home_timeout_ms`, `home_probe_timeout_ms` — number inputs.

Each field shows the env default and a "reset to default" affordance (clears the
override via `PUT … null`). Save issues a single `PUT` with changed keys.

### 6. Footgun handling

Overrides change what Legion **requests**. The model must already be **pulled on the
PC**; the dropdown enforces this whenever the PC is reachable. PC-side prime/advertise
(`legion-pc.config.ps1`) is unchanged — picking an already-pulled model works next
cycle (only a cold-load cost if it differs from what prime warmed). If `home_fallback`
is pinned and the requested model is absent on the PC, the agent abstains (documented).

## Testing

- **Overlay** (`applyRuntimeOverrides`): coercion per type; DB-over-env precedence;
  absent key keeps default; invalid value ignored (no throw).
- **Registry**: each descriptor's `cfgPath` resolves to a real `cfg` location.
- **Repo**: `getRuntimeConfig`/`setRuntimeConfig`/`deleteRuntimeConfig` round-trip
  (existing repo test harness).
- **API**: `GET` shape (value/source/default); `PUT` upsert, reset (null → delete),
  unknown-key 400, type-invalid 400; `pc-models` fail-soft returns `{models:[]}`.
- **get-provider integration**: a `home_model` DB row changes the resolved PC tier model
  next call; `home_pc_enabled=false` still routes to Oracle (regression).
- **Web**: settings page renders from GET, dropdown from pc-models, save PUTs changed
  keys, reset clears.

## Apply latency

Next cycle. `buildGetProvider` reads `runtime_config` per cycle (cheap, same as today's
toggle). Not applied mid-cycle.

## Rollout

Pure additive: with no `runtime_config` rows, behavior is byte-identical to env-only
today. Set overrides from the dashboard after deploy. No migration needed.
