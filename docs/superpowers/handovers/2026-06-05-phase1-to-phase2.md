# Handover: Phase 1 → Phase 2 (Multi-Agent Consensus)

**Date:** 2026-06-05
**From:** Phase 1 (single Technical agent end-to-end) — DONE
**To:** Phase 2 (four voting agents + Risk Manager + multi-round consensus + scheduler)
**Plan to execute:** `docs/superpowers/plans/2026-06-04-legion-phase2-consensus.md`
**Method:** subagent-driven-development (one TDD implementer subagent per task), same as Phase 0/1.

---

## 1. Where things stand

- **Phase 0** (foundation libs) merged on `main` (up to `9b447e2`).
- **Phase 1** (single agent) on branch **`claude/legion-phase1`**, **PR #1** open against `main`
  (`github.com/givewgun/legion/pull/1`), 12 commits `7968cbb..730da2a`, **75 vitest tests green**, lint clean, **unmerged**.

**FIRST ACTION for the Phase 2 session:** confirm PR #1 is merged to `main` (or decide to branch Phase 2 off `claude/legion-phase1`). Phase 2 depends on every Phase 1 module. Do **not** start Phase 2 on top of a `main` that lacks Phase 1.

Then branch: `git checkout -b claude/legion-phase2` off whatever has Phase 1.

## 2. What Phase 2 builds (13 tasks)

1. **Constraint subjects** — `constraintSubject(t,r)` + `constraintWildcard()` in `src/bus/subjects.js`.
2. **Shared vote parser** — promote `agents/technical/parse.js` → `src/agents/parse.js`; technical keeps a thin re-export.
3. **Peer dissent summarizer** — `src/agents/peers.js` (`summarizePeers(priorVotes, selfId)`).
4. **Shared agent factory** — `src/agents/factory.js` + `src/agents/format.js` (`RESPONSE_SPEC`, `dissentBlock`). Technical `prompt.js`/`index.js` refactored to delegate. **This is the refactor that the other 3 agents reuse.**
5. **News/Catalyst agent** — `src/agents/news/` (weight 1.2; gather = headlines + macro).
6. **Social agent** — `src/agents/social/` (weight 0.8; gather = sentiment).
7. **Contrarian agent** — `src/agents/contrarian/` (weight 0.9; gather = sentiment + macro VIX; leans on peer dissent).
8. **Risk Manager** — `src/risk/{rules,apply,gather,manager}.js`. **Non-voting** constraint node; publishes on `constraintSubject`.
9. **Emitter v2** — REWRITE `src/emit/emitter.js`. Keys pending by `${cycleId}:${round}`, waits for `expectedAgents` votes **and** (if `riskEnabled`) the constraint, persists **every** round, then finalizes (converged or `round>=maxRounds`) or iterates (republish `cycleSubject` with `round+1` + `priorVotes`). Phase 1 emitter test is **replaced**.
10. **Multi-ticker scheduler** — `src/scheduler.js` + `repo.listEnabledTickers()` (adds `node-cron` dep).
11. **E2E consensus test** — `test/e2e/consensus.test.js` (multi-agent, multi-round over in-memory bus).
12/13. Run entrypoints (`agent-news.js`, `agent-social.js`, `agent-contrarian.js`, `risk.js`, `scheduler.js`), emitter env wiring (`expectedAgents`, `riskEnabled`), README.

## 3. Carry-over from Phase 1 you MUST honor

**Interfaces Phase 1 froze (do not redefine — Phase 2 plan §17 lists them):**

- Bus: `cycleSubject(t)`, `voteSubject(t,r)`, `consensusSubject(t)`, `cycleWildcard()` (`legion.cycle.*`), `voteWildcard()` (`legion.vote.>`), `createMemoryBus()` (`*`=one token, `>`=trailing).
- Vote shape: `{ agentId, stance, conviction, weight, rationale }`; stance ordinal `-2..+2`.
- `evaluateRound(votes, { thetaV, quorum, holdBand })` → `{ S, V, kappa, converged, band }`.
- Cycle msg: `{ cycleId, symbol, round, priorVotes? }` (round 1 omits `priorVotes`; agents default `[]`).
- `buildSignal`, `sendTelegram`, `formatSignal`, repo `createCycle/addRound/addVote/addSignal/finishCycle`.

**Consensus math anchor (from Phase 0, keep consistent):** converge iff `κ ≥ 2/3` AND `V ≤ θ_v (0.5)`; `R_max=3` else NO_CONSENSUS/HOLD. `directionalQuorum` uses the **neutral-inclusive hybrid** (commit `08501ce`): target=sign(S), but when `|S|<holdBand` the HOLD voters (side 0) also count as agreeing. Don't "fix" this — it's intentional and test-locked.

**Effective weight:** `W_i = w_i · ρ_i`; ρ defaults 1.0 until Phase 4. Roster priors: technical 1.0, news 1.2, social 0.8, contrarian 0.9.

## 4. Known caveats / open items inherited

1. **`cycles.symbol` has FK → `legion.tickers`.** Live `createCycle` (and so the scheduler in Task 10) errors if the ticker isn't seeded in `legion.tickers` first. Seed enabled tickers before any live kick; `listEnabledTickers()` reads that same table.
2. **GunVest route shapes are ASSUMED**, not confirmed against the live backend:
   - `getPrice` → `{ changePercent, ... }` (used by technical + risk)
   - `getNews(sym)` → `[{ title }]`, `getMacro()` → `{ vix }`, `getSentiment(sym)` → `{ score, volume }`
   Confirm these vs `gunvest/backend` before wiring live agents; adjust each agent's `gather.js` if JSON differs. Routes presumed: `/api/market`, `/api/news`, `/api/sentiment`, `/api/macro`.
3. **Live-run hardening NOT done in Phase 1** (deferred, still open): bus handlers are fire-and-forget (`handleCycle(msg)` not awaited) so an unhandled promise rejection is unobserved — fine for the synchronous in-memory test bus, revisit for real NATS; orchestrator `setTimeout(...,500)` exit doesn't `bus.close()`/drain; entrypoint `connect*()` errors crash top-level. Phase 2 adds more long-running processes (risk, scheduler) — consider a small shared bootstrap with try/catch + graceful close.
4. **LLM JSON-compliance rate unmeasured.** `parseVote` abstains (HOLD/0) on unparseable output. With 4 agents the abstain rate compounds; if the local model is sloppy, dispersion `V` rises and rounds won't converge. Worth measuring early (Phase 1 handover item #5) — may motivate a stricter prompt or a single re-ask before abstaining.
5. **`parse.js` greedy regex `/\{[\s\S]*\}/` is deliberate** (handles nested JSON objects; a non-greedy `*?` would break them). The shared parser in Task 2 copies it verbatim — keep it greedy.

## 5. Test/infra notes

- All tests are infra-free: fake `pg` pool, stubbed provider/gunvest, in-memory bus. Keep it that way — no broker/DB in CI.
- `vi.waitFor(...)` is used because agent/emitter handlers are async-dispatched even on the sync bus.
- Multi-round iteration **reuses `cycleSubject(symbol)`** with an incremented `round` — never invent a new "round" subject. Agents distinguish rounds by the `round` field + `priorVotes`.
- Emitter v2 keys by `${cycleId}:${round}` — the Phase 1 `cycleId`-only Map would collide across rounds. The Phase 1 emitter test is **replaced**, not extended.
- Pre-commit hook (lint-staged + eslint) runs on every commit. **Never `--no-verify`.**

## 6. Definition of done (Phase 2)

Four agents + risk manager reach consensus over ≥1 round on the in-memory bus with a stubbed LLM; emitter persists every round, applies the risk constraint to magnitude only (never flips direction), emits on the final round; scheduler kicks every enabled ticker; full suite green (Phase 0+1+2); lint clean. Then write the Phase 2→3 handover (dashboard) and open a PR.

**Next after Phase 2:** Phase 3 — dashboard / debate viewer (`docs/superpowers/plans/2026-06-04-legion-phase3-dashboard.md`). The per-round persistence added in Phase 2 Task 9 is what the debate viewer reads.
