# Show served model + run location on the debate / run — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorm), pending spec review
**Branch:** `claude/debate-model-location`

## Goal

Make every agent vote say **which model produced it** and **where that model ran**, so
the dashboard debate view and the Telegram signal show, per agent, e.g.
`gpt-oss:20b · onprem` vs `qwen2.5:7b · cloud`. Today the served model is captured only on
the final `signal_votes` row (for reliability), and the run location is discarded
entirely — the tiered provider knows which tier served but throws that fact away.

## Non-goals

- **Parallelizing / speeding up PC inference.** Considered and explicitly deferred: GPU
  parallelism is VRAM-bound and `gpt-oss:20b` (~12–13 GB of the 16 GB card) leaves no room
  for parallel KV slots, so the box stays serial. Revisit later, possibly with a smaller
  model. Not in this change.
- Changing the consensus / emitter protocol, reliability math, or provider selection logic.
- Showing model/location on the SignalFeed page or anywhere beyond debate + Telegram.

## Background — current data flow

- 4 agent processes subscribe to NATS cycle events and run in parallel. Each agent calls a
  provider: the tiered `local` provider (PC primary → Oracle fallback), or `openai`/`gemini`.
- `normalizeGenerate` already returns `{ text, model }`; the vote already carries `model`.
- **Gap 1 — location lost:** `tiered.js` returns `{ text, model }` and drops which tier
  (PC vs Oracle) served. Plain providers carry no source identity at all.
- **Gap 2 — per-round table has neither:** `legion.votes` (the debate audit table that
  `assembleDebate` → `DebateThread` renders) has no `model` and no `source` column. Only
  `signal_votes` (the final signal) stores `model`.
- **One surface, not two:** `DebateViewer` renders both finished *and* in-progress cycles
  from the same `assembleDebate` → `DebateThread` path, so "debate thread" and "live cycle
  view" are a single surface. Two display targets remain: DebateThread and Telegram.

## Design

### Vocabulary

- **`source`** — a stable named id for the serving backend: `pc`, `oracle`, `openai`,
  `gemini`. Stored on the vote and in `legion.votes`.
- **`location`** — a display class derived from `source`: `pc → onprem`, everything else
  → `cloud`. **Not stored** — derived at the display edge from `source` via a 1-line map.

### 1. Providers report who served (`src/llm/*`)

- **`ollama.js`** — `createOllamaProvider({ …, source })` exposes a `source` property on the
  returned provider (default `'oracle'` for back-compat; the home tier passes `'pc'`).
- **`openai.js`** — the returned provider exposes `source` = its `name` (`openai` / `gemini`).
- **`provider.js` `buildLocalProvider`** — constructs the Oracle provider with
  `source: 'oracle'` and the PC provider with `source: 'pc'`.
- **`tiered.js`** — `generate` returns `{ text, model, source }`, taking `source` from the
  tier that actually served (`primary.source` on success, `fallback.source` on failover).
  Not hardcoded — read from each tier's provider.
- **`normalizeGenerate`** — string result → `{ text, model: provider.model ?? null,
  source: provider.source ?? null }`; object result (tiered) → returned as-is.

### 2. Plumb `source` through the vote

- **`vote.js` `createVote`** — add `source = null`, included in the returned object.
- **`parse.js` `parseVote`** — accept `source` alongside `model`, pass to `createVote`.
- **`factory.js` `handleCycle`** — capture `out.source` next to `out.model`; pass into
  `parseVote` and into `abstain(...)` (a fetch-failed abstain has no source → null).
- `scaleWeights` / `scaleConviction` already spread `...v`, so `model` + `source` survive
  aggregation untouched. No change needed there.

### 3. Persist on the per-round audit table

- **`schema.sql`** — append, in the existing idempotent-ALTER style (no new migration file):
  ```sql
  ALTER TABLE legion.votes ADD COLUMN IF NOT EXISTS model  TEXT;
  ALTER TABLE legion.votes ADD COLUMN IF NOT EXISTS source TEXT;
  ```
- **`repo.js` `addVote`** — INSERT `model, source` (from the vote).
- **`repo.js` `getVotes`** — SELECT `model, source`.
- Legacy rows keep `NULL` model/source → the display falls back to "unknown" / no badge.

### 4. Display — DebateThread

- **`web/src/lib/debate.js` `threadModel`** — surface `model` and `source` per message;
  derive `location` from `source` via a small `web/src/lib` map (`pc → onprem`, else
  `cloud`; null source → null).
- **`DebateThread.jsx`** — a small muted badge per message, e.g. `gpt-oss:20b · onprem`,
  colored by class (onprem vs cloud). Omitted when model is null (legacy rows).

### 5. Display — Telegram

- **`plan.js` `buildSignal`** — the per-agent `rationales` entries carry `model` and
  `source` (read off each vote).
- **`telegram.js` `formatSignal`** — append served model + location to each agent line,
  e.g. `• _news_: … (gpt-oss:20b, onprem)`. Escaped per MarkdownV2. Omitted when null.
- **Location map** — backend copy lives in `src/llm/` (e.g. `locationForSource(source)`),
  imported by telegram. Frontend keeps its own 4-line copy (separate bundle; YAGNI on a
  shared module for one trivial map).

## Data flow (after)

```
provider.generate → { text, model, source }     (tiered: source = serving tier)
  → normalizeGenerate → { text, model, source }
  → parseVote → vote { …, model, source }
  → NATS → emitter → scaleWeights/Conviction (…v preserved)
       ├─ repo.addVote → legion.votes(model, source)        → DebateThread badge
       └─ buildSignal rationales(model, source) → formatSignal → Telegram line
location = onprem if source==='pc' else cloud   (derived at each display edge)
```

## Testing (TDD)

- **`tiered.js`** — served-source is `pc` when primary serves, `oracle` on failover.
- **`provider.js`** — `normalizeGenerate` passes `source` through (object) and reads
  `provider.source` (string); `buildLocalProvider` tags `pc` / `oracle`.
- **`openai.js`** — provider exposes `source` = name.
- **`vote.js` / `parse.js`** — vote carries `source`; parse threads it.
- **`repo.js`** — `addVote` → `getVotes` round-trips `model` + `source`; null-safe.
- **`debate.js`** — `threadModel` surfaces model/source and derives location.
- **`telegram.js`** — agent line includes `(model, location)`; omitted when null.
- **`plan.js`** — `buildSignal` rationales include model + source.
- **`source` map** — `locationForSource('pc') === 'onprem'`; others `cloud`; null → null.

All unit-level with injected fakes — no live Ollama / network / DB.

## Scope

- **Modified backend:** `src/llm/tiered.js`, `src/llm/ollama.js`, `src/llm/openai.js`,
  `src/llm/provider.js`, `src/consensus/vote.js`, `src/agents/parse.js`,
  `src/agents/factory.js`, `src/db/schema.sql`, `src/db/repo.js`, `src/emit/plan.js`,
  `src/emit/telegram.js`.
- **New backend:** `src/llm/source.js` (`locationForSource`) + its test.
- **Modified frontend:** `web/src/lib/debate.js`, `web/src/components/DebateThread.jsx`,
  a `web/src/lib` location helper.
- **Tests:** new/extended cases in the matching `test/**` files.
- **Docs:** update `docs/snapshot-format.md` only if a snapshotted shape changes (it does
  not — votes are not snapshotted); note the new `votes.model/source` columns where the
  schema is documented.
