# Handover: Phase 4 → Phase 5 (Backtest + Reliability → Summary + Polish)

**Date:** 2026-06-06
**From:** Phase 4 (forward paper-test, Brier reliability loop, deterministic backtest, dashboard tabs) — DONE on `claude/legion-phase4`
**To:** Phase 5 (6h Telegram summary, provider-switch UI, add-agent docs, ADRs, final polish)
**Plan executed:** `docs/superpowers/plans/2026-06-04-legion-phase4-backtest-reliability.md`
**Plan for next:** `docs/superpowers/plans/2026-06-04-legion-phase5-summary-polish.md`
**Method:** subagent-driven-development (TDD per task).

---

## 1. Where things stand

- **Phases 0–3** merged to `main` (PR #4). **CI/CD + Oracle VM deploy** merged (PR #5). A later `main` commit `f1f9d6d "fix: fix prod deployment domain"` is the current `origin/main` tip.
- **Phase 4** on **`claude/legion-phase4`** — **12 commits** `555f5b3..8dbc239` on top of `fd6e7ac`. **PR not yet opened.**
  - Backend suite: **227 tests green** (58 files).
  - Web suite (`web/`): **18 tests green** (7 files); `npx vite build` clean.
  - `npx eslint src test` (backend) and `web/` `npx eslint src test` both clean.
- **FIRST ACTION for Phase 5:** open a PR for `claude/legion-phase4` → `main` (the branch is built on `fd6e7ac`; `origin/main` has since advanced to `f1f9d6d` — rebase or merge `main` in if the deploy-domain fix is needed in the diff). Then `git checkout -b claude/legion-phase5`.

## 2. What Phase 4 built (12 tasks)

1. `src/consensus/reliability.js` — pure: `forecastProb`, `brier`, `reliabilityFromBrier`, `scaleWeights` + constants `MIN_RESOLVED=5`, `WINDOW=50`.
2. `src/db/schema.sql` — **extended** (idempotent `ALTER ... ADD COLUMN IF NOT EXISTS`) the Phase 0 stub tables `agent_reliability` (+`rho`,`sample_size`) and `backtest_results` (+`strategy`,`trades`,`hits`,`hit_rate`,`pnl`,`spy_pnl`,`qqq_pnl`); new table `signal_votes`; resolution columns on `signals` (`entry_price`,`horizon_days`,`resolve_after`,`resolved`,`forward_return`,`spy_return`,`qqq_return`,`outcome`,`correct`) + partial index `idx_signals_unresolved`.
3. `src/data/gunvest.js` — `getCandles(symbol, days)` → ascending `[{date, close}]`.
4. `src/db/repo.js` — `addSignal` extended (persists entry/horizon/resolveAfter, still `(cycleId, signal)`); new `addSignalVotes`, `getAllReliability`, `upsertReliability`, `getReliabilityLeaderboard`, `listUnresolvedSignals`, `resolveSignal`, `getSignalStance` (derives stance from `band` via `STANCE`), `getResolvedForecasts`, `recordBacktestResult`, `listBacktestResults`.
5. `src/reliability/resolver.js` — `returnOver`, `resolveSignals(repo, gunvest, now)`: forward/SPY/QQQ returns, `outcome = forwardReturn > spyReturn`, `correct` = direction vs excess (null for HOLD).
6. `src/reliability/update.js` — `recomputeReliability(repo)`: Brier per agent → ρ via `reliabilityFromBrier`, upserts, returns `{agentId: rho}`.
7. `src/emit/emitter.js` — loads ρ once per cycle, `scaleWeights` before every aggregation, snapshots scaled per-agent forecasts (`addSignalVotes`) + entry price (`gunvest.getPrice`) + `resolveAfter = now + horizonDays`. New optional ctor params `gunvest`, `horizonDays`, `clock` (safe defaults keep Phase 2 construction valid).
8. `src/backtest/indicators.js` — pure `sma`/`ema`/`rsi`/`macd`/`computeIndicators`/`quantStance`.
9. `src/backtest/deterministic.js` — `runBacktest(candles, spy, qqq, {horizon})` → `{trades, hits, hitRate, pnl, spyPnl, qqqPnl}`.
10. `src/api/routes/reliability.js` + `src/api/routes/backtest.js`, mounted in `src/api/app.js` — `GET /api/reliability`, `GET /api/backtest[?symbol=]`.
11. `config` (`reliabilityCron` default `0 */12 * * *`, `horizonDays` default 5), `src/run/reliability.js` (cron + `--now`), `src/run/backtest.js` (one-shot CLI), npm scripts `reliability`/`backtest`, `docker-compose.yml` `reliability` service.
12. `web/` — `api.getReliability`/`getBacktest`, `ReliabilityBoard.jsx` + `BacktestPage.jsx` (named exports), two new tabs in `App.jsx`.

## 3. Plan deviations (intentional — plan assumed conventions that differ from merged code)

See `memory/project_legion_phase4_adaptations.md`. Summary:
- Repo is `createRepo(db)` with `db.query`→**bare rows array** / `db.queryOne`→row|null (not `pool.query`→`{rows}`). Fake-db tests fake the pg pool and wrap with real `createDb`.
- GunVest client is `src/data/gunvest.js`, `createGunvestClient(baseUrl, fetchImpl)` **positional**.
- Config is `src/config/index.js`, `loadConfig(env)`; key is `gunvestApiUrl`.
- Migrations are a **single `src/db/schema.sql`** (no `migrations/` dir); Phase 4 extends it idempotently and **coexists** with the Phase 0 stub columns (legacy `reliability`/`brier_score`/`sample_count` on `agent_reliability` and `signal_return`/`index_return`/`resolved_at` on `backtest_results` remain, unused; `backtest_results.horizon` stays legacy `TEXT` and receives an integer — pg coerces).
- `signals` has `band` (text), not `stance`; signal direction is derived from band via the existing `STANCE` map.
- Emitter uses `telegram(...)` as a function, `bus.publishJSON/subscribeJSON`, `buildSignal(result, {symbol, votes})`.
- **quantStance was redesigned** (Task 8/9): the plan's additive rule let an overbought RSI flip a clear uptrend to a losing short. New rule: SMA-cross sets the side, a confirming MACD escalates to ±2, and an RSI extreme only **de-escalates** an over-extended (±2) reading — it never flips the side. This is the only logic change from the plan's pure code.

## 4. Interfaces frozen (do not redefine)

- **API:** `GET /api/reliability` → `[{agentId, rho, sampleSize}]` (ρ desc); `GET /api/backtest[?symbol=]` → backtest rows (snake_case: `symbol`,`horizon`,`trades`,`hits`,`hit_rate`,`pnl`,`spy_pnl`,`qqq_pnl`), capped 50.
- **Client (`web/src/api/client.js`):** `api.getReliability()`, `api.getBacktest(symbol?)`.
- **Reliability math (keep consistent):** `forecastProb = clamp(0.5 + s·c/4, 0, 1)`; `ρ = clamp(1 + 2(0.25 − meanBrier), 0.5, 1.5)`; neutral 1.0 below `MIN_RESOLVED=5`; window `WINDOW=50`; outcome = alpha vs **SPY only** (QQQ stored for display, not scored).
- **Effective weight `W_i = w_i · ρ_i` is live**: the emitter reads `agent_reliability` each cycle. A fresh deploy behaves identically to Phase 3 until ≥5 signals per agent resolve (ρ stays 1.0). ρ only moves after signals age past `HORIZON_DAYS` and `runReliabilityOnce` runs. Backtest results populate immediately (historical), so the Backtest tab shows life first.

## 5. Known caveats / deferred (carry forward)

1. **Live VM schema reconciliation:** `schema.sql` re-extends the Phase 0 stub tables via `ADD COLUMN IF NOT EXISTS`. On the running Oracle VM, re-run `npm run db:migrate` (idempotent) to pick up the new columns before starting the `reliability` service / backtest CLI. The stub tables had no Phase 4 data, so this is additive and safe.
2. **Manual browser verification DEFERRED** (Task 12 Step 6): needs Postgres + seeded `legion` schema + GunVest API + `node src/run/api.js` + `web` dev server — unavailable in the build env (same as prior phases). Pages are unit-tested (RTL/jsdom) and `vite build` compiles clean. Recommend a real browser pass once infra is up: Backtest tab shows a row per ticker (hit-rate/P&L vs SPY/QQQ); Reliability tab shows ρ per agent or the empty state.
3. **GunVest candles endpoint unverified live:** `getCandles` assumes `GET /api/market/:symbol/candles?days=` returning `{candles: [{date, close}]}`. **Verify this exists in GunVest**; if the shape differs, adjust only the mapping in `src/data/gunvest.js`, nothing downstream.
4. **`getSignalStance` is a per-signal extra query** in the resolver loop — fine at low volume; batch into `listUnresolvedSignals` if it gets hot.
5. **No de-duplication** if a ticker is evaluated twice within one horizon window — each emitted signal is scored independently.
6. **Deterministic backtest indicators are intentionally NOT shared** with the Technical agent's LLM-prompt indicators (different consumers; coupling avoided). Unify behind one module only if they should converge later.
7. **Git hazard hit during this phase** (see `memory/feedback_subagent_git_branch_hazard.md`): the working tree was switched to `main` for a deploy fix mid-run and an implementer subagent committed Task 7 onto `main`; recovered via cherry-pick onto the feature branch and `git branch -f main f1f9d6d`. Verify `git branch --show-current` before dispatching commit-making agents.

## 6. Definition of done (Phase 4) — met

Forward paper-test logging + resolved outcomes ✓ · index comparison (SPY/QQQ) for alpha ✓ · deterministic LLM-free backtest ✓ · per-agent ρ via Brier feeding `W_i = w_i·ρ_i` ✓ · Reliability + Backtest dashboard tabs ✓ · full suite green (227 backend + 18 web) ✓ · lint clean ✓. Remaining: open/refresh the PR.

**Next — Phase 5 (summary + polish):** 6h Telegram summary aggregating the window's signals, provider-switch UI (per-agent local/Gemini), add-agent docs, ADRs (consensus, message bus, inference abstraction, deployment), final polish. Plan: `docs/superpowers/plans/2026-06-04-legion-phase5-summary-polish.md`.
