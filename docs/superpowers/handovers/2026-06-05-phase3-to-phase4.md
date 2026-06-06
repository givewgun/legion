# Handover: Phase 3 → Phase 4 (Backtest + Reliability)

**Date:** 2026-06-05
**From:** Phase 3 (dashboard: legion-api + web SPA) — DONE
**To:** Phase 4 (forward paper-test logging, index comparison, deterministic sub-signal backtest, per-agent ρ_i Brier loop + Backtest tab)
**Plan to execute:** `docs/superpowers/plans/2026-06-04-legion-phase4-backtest-reliability.md`
**Method:** subagent-driven-development (one TDD implementer subagent per task), same as Phase 0–3.

---

## 1. Where things stand

- **Phase 0** (foundation) merged on `main`.
- **Phase 1** (single technical agent) — folded into the Phase 2 line that merged to `main`.
- **Phase 2** (4 agents + risk + multi-round consensus + scheduler + live contrarian feeds) — **MERGED to `main`** (`claude/legion-phase2` is a clean ancestor of `origin/main`). **143 tests green** at merge.
- **Phase 3** (dashboard) on **`claude/legion-phase3`**, 8 commits `acb2f57..469f074` + handover `fc9c185`. **PR #4 open against `main`** (https://github.com/givewgun/legion/pull/4) — phase3-only diff (9 commits, 42 files). Unmerged pending review + live browser pass.
  - Backend suite: **167 tests green** (143 prior + 24 new across repo.read/debate/tickers/cycles/signals).
  - Web suite (`web/`, own vitest): **14 tests green** (format 3, client 5, RoundCard 2, SignalFeed 2, TickerConfig 2).
  - `npx eslint src test` clean; `web/` `npm run build` succeeds.

**FIRST ACTION for the Phase 4 session:** confirm PR #4 is merged to `main` (or decide to branch Phase 4 off `claude/legion-phase3`). Phase 4 depends on Phase 3's dashboard (adds a Backtest tab) and Phase 2's per-round persistence. Do not start Phase 4 on a `main` that lacks Phase 3 if the Backtest tab work assumes the dashboard shell. Then `git checkout -b claude/legion-phase4` off whatever has Phase 3.

## 2. What Phase 3 built (8 tasks)

**Backend — `legion-api` (thin, data-only Express; reuses Phase 0 `db`/`repo`):**
1. Repo read + ticker-config methods (`src/db/repo.js`): `listTickers/upsertTicker/setTickerEnabled/listCycles/getCycle/getRounds/getVotes/listSignals` + `test/db/repo.read.test.js`.
2. `src/api/debate.js` `assembleDebate(repo, cycleId)` → `{ ...cycle, rounds: [{ ...round, votes }] }`, null on unknown cycle.
3. `src/api/app.js` `createApp({ repo })` (no `listen`) + `src/api/routes/tickers.js` (GET/POST/PATCH). Added deps `express`, dev `supertest`.
4. `src/api/routes/cycles.js` — `GET /api/cycles?symbol=` (list) + `GET /api/cycles/:id` (debate tree, 400 non-int, 404 unknown).
5. `src/api/routes/signals.js` — `GET /api/signals[?symbol=]`; `apiPort` (`LEGION_API_PORT`, default 8088) in config; `src/run/api.js` entrypoint; `npm run api` script.

**Frontend — `web/` (own Vite + React 18 + Tailwind + vitest/jsdom, mirrors GunVest stack):**
6. Scaffold (`web/package.json`, vite/tailwind/postcss config, index.html, `.gitignore`), `web/src/api/client.js` (typed fetch wrapper), `web/src/lib/format.js` (`pct/stanceLabel/bandColor`).
7. Components `VoteRow`/`RoundCard`; pages `SignalFeed`/`DebateViewer`/`TickerConfig` + RTL tests.
8. `App.jsx` (3-tab shell, no router — local state), `main.jsx`; README Phase 3 section; `docker-compose.yml` api+web services; `web/Dockerfile`.

## 3. Interfaces Phase 3 froze (do not redefine)

- **API routes:** `GET/POST /api/tickers`, `PATCH /api/tickers/:symbol`, `GET /api/cycles?symbol=`, `GET /api/cycles/:id`, `GET /api/signals[?symbol=]`, `GET /health`.
- **Client (`web/src/api/client.js`):** `api.{listTickers, addTicker, setTicker, listCycles, getDebate, listSignals}` — names/paths/verbs match the routes 1:1. This is the SOLE backend↔SPA seam (API data-only, SPA presentation-only).
- **Row shapes flowing repo→route→client→component:** ticker `{ symbol, enabled }`; cycle `{ id, symbol, status, started_at, ended_at }`; round `{ id, round_no, s_score, dispersion, quorum, converged }`; vote `{ agent_id, stance, conviction, weight, rationale }` (snake_case — components consume snake_case); signal `{ id, symbol, band, conviction, plan, created_at }`. Debate = `{ ...cycle, rounds: [{ ...round, votes: [...] }] }`.
- **Repo conventions:** wrapped `db.query()` returns a **bare rows array** (NOT `{ rows }`); `db.queryOne()` returns one row or null. (Phase 3 plan's `const { rows } = ...` was adapted to `const rows = ...` — keep this in any new repo methods.)
- **Config:** numeric env via the `num(env, KEY, default)` helper (used for `apiPort`).

## 4. Known caveats / open items inherited (carry forward)

1. **`signals.plan` JSON round-trip unverified live.** Stored via `JSON.stringify`; `pg` may return JSONB already-parsed. The Signal feed renders only `symbol/band/conviction` so it's unaffected, but the Backtest tab (Phase 4) will read `plan` — confirm its actual runtime shape before relying on it.
2. **No live update.** Pages fetch once on mount; no polling/WS (Phase 2 reserved a `WS` channel, deferred). Add polling or WS if the Backtest/Signals tabs need live refresh.
3. **Pagination capped** at `listCycles` 20 / `listSignals` 50 — add params if ticker/cycle counts grow.
4. **API is unauthenticated** (single-user private VM). Add a token guard before any public exposure.
5. **`web/` vite proxy targets `localhost:8088`** for dev. In docker/prod the proxy target should point at the `api` service URL — documented follow-up, not yet done.
6. **Manual browser verification DEFERRED** (Phase 3 plan Task 8 Step 5): needs running Postgres + seeded `legion` schema + API + vite dev server, unavailable in the build env (same as prior phases' live smoke). The shell is presentation wiring over unit-tested pages; `npm run build` compiles clean. **Recommend a real browser pass once infra is up** before merge: Signals lists with band colors; Config add/toggle persists to `legion.tickers`; Debate ticker→cycle→rounds renders S/V/κ + per-agent votes.
7. **`cycles.symbol` FK → `legion.tickers`** (from Phase 0): seed enabled tickers before any live cycle, or `createCycle` errors. The Config tab now writes that table.
8. **Cosmetic React `act()` warning** in `TickerConfig.test.jsx` (toggle test) — post-click `refresh()` settles state after the synchronous assertion; reviewer confirmed it cannot cause a false pass/fail. Left as-is per plan; tidy with `await waitFor(...)` if it bothers you.

## 5. Test/infra notes

- Backend tests stay infra-free (fake `pg` pool, `supertest` in-process against `createApp`, stubbed repo). `web/` tests use jsdom + `vi.spyOn(api, ...)` + `vi.restoreAllMocks()` (no global `vi.mock`). Keep both that way — no broker/DB/browser in CI.
- `web/` is a **separate npm project** — its deps and vitest never mix with the backend's. Run web tests from inside `web/`.
- Pre-commit hook (lint-staged + eslint) runs on every commit. **Never `--no-verify`.**

## 6. Definition of done (Phase 4)

Per `2026-06-04-legion-phase4-backtest-reliability.md`: forward paper-test logging of emitted signals + resolved outcomes; index comparison (SPY/QQQ) for alpha; deterministic sub-signal backtest (no LLM replay); per-agent reliability `ρ_i` via Brier loop feeding `W_i = w_i · ρ_i` (ρ defaults 1.0 until ≥5 resolved — wired but inert before Phase 4); a Backtest tab added to the Phase 3 dashboard. Full suite green (backend + web); lint clean. Then write the Phase 4→5 handover and open/refresh a PR.

**Reliability math anchor (Phase 0, keep consistent):** `ρ = clamp(1 + 2(0.25 − meanBrier), 0.5, 1.5)`, neutral 1.0 until ≥5 resolved; `forecastProb = clamp(0.5 + s·c/4, 0, 1)`; outcome = alpha vs SPY.

**Next after Phase 4:** Phase 5 — summary polish (`docs/superpowers/plans/2026-06-04-legion-phase5-summary-polish.md`).
