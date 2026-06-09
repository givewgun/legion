# Handoff: Oracle VM memory growth investigation

_Session handoff — continue in VS Code at home. Status as of 2026-06-09 ~09:00 UTC._

## TL;DR

- **Symptom:** Oracle VM memory ratcheted up step-by-step on every scheduler sweep (CPU spike → memory steps up → holds), climbing ~5% → ~50% over ~a day, then **plateaued flat at ~50%**.
- **A real leak was found and fixed** in the emitter (`src/emit/emitter.js`) — shipped in **PR #25** (merged) — but it may **not** be what this particular graph shows.
- **Key unresolved fact:** the 08:36 UTC auto-deploy recreated the legion app containers (incl. `legion-emitter`) but memory did **not** drop afterward. Since the deploy did **not** restart `legion-ollama` / `legion-nats` / the gunvest stack, the ~50% is most likely **held by a process we didn't restart — prime suspect: the Ollama model resident in RAM (~5–6 GB for `qwen2.5:7b`), which is normal baseline, not a leak.**
- **NEXT STEP (do this first at home):** get the per-process memory breakdown from the VM — we never did, and we've been inferring from graph shape. Command + interpretation below.

## THE command to run on the VM (decides everything)

```sh
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
free -h
# total VM RAM, to convert the % to GB:
grep MemTotal /proc/meminfo
```

Interpretation:
- **`legion-ollama` is the big one (multi-GB)** → it's the model held resident. Expected baseline, **not a bug**. The flat-at-50% line confirms steady state. If you want it released when idle, set Ollama `keep_alive` (e.g. `OLLAMA_KEEP_ALIVE=0` or a short TTL) so the model unloads between sweeps — tradeoff: cold-load latency on the next sweep.
- **`legion-emitter` RSS still large / growing across the next sweep** → the PR #25 fix didn't fully take or there's a second path. Re-investigate (see "If it's still the emitter").
- **`gunvest-*` or `legion-nats` is the holder** → a different leak entirely; pivot there.

## What the graphs showed

- CPU: flat ~0–2% with sharp spikes to ~100% at sweep times. Sweep cron (prod): `LEGION_CRON=0 8,13,20,22,2,4 * * 1-5` (UTC, weekdays) → 02:00, 04:00, 08:00, 13:00, 20:00, 22:00.
- Memory: stair-step up, each step aligned to a CPU spike, then a flat plateau at ~50% for the last several hours of the window. Alarm threshold 85%.
- A ratchet (step-up-and-hold) = memory retained per work-batch. A flat plateau = steady state (no longer actively growing).

## The real bug that WAS fixed (PR #25, merged)

`src/emit/emitter.js` buffers per-`(cycleId, round)` vote state in `Map`s that were only freed on the happy path (a round collecting all `expectedAgents` votes, or a cycle finalizing). Any round that never completes pinned its buffers forever:
- an agent process down/restarting (fewer than `expectedAgents` votes arrive),
- a missing risk constraint (`riskEnabled` but none published),
- `LEGION_EXPECTED_AGENTS` set higher than the agents actually running → **every** round leaks,
- a late/duplicate vote re-creating a finalized entry via `touch()`.

`learnedByCycle` entries are heavy — each closure (`corr`) captures the whole correlation map, so each leaked cycle pinned a full reliability/correlation snapshot.

**Fix shipped:** age-based lazy sweep evicting buffers older than `staleEntryMs` (default 30 min, env `LEGION_EMITTER_STALE_MS`), `cycleSeenAt` cleanup on finalize, and a read-only `stats()` accessor (`{ pendingRounds, pendingCycles }`). Plus a follow-up (Codex review): `cycleSeenAt` tracks **last activity**, not first-seen, so a slow multi-round cycle isn't swept mid-deliberation (which would have bypassed the anti-herding guard). Full suite green (382).

## Why this graph may NOT be that leak

The 08:36 UTC deploy recreated `legion-emitter` (fresh process, old heap gone) — yet memory stayed at ~50%. If the emitter had been holding the leaked memory, it would have dropped. It didn't. Things the deploy did **NOT** restart (stayed "Running"): `legion-ollama`, `legion-nats`, gunvest-db / gunvest-app. So the resident ~50% is almost certainly one of those — most plausibly the Ollama model (normal). Caveat: the deploy landed right at the right edge of the graph (08:36) and the metric is "Mean" over an Auto interval, so a small post-deploy drop could be muted — re-check the graph for data after ~09:00 UTC.

## Deployment / CI facts (so you don't re-derive)

- **CI already auto-deploys on merge to main.** `.github/workflows/ci.yml` job chain: `verify → web → docker → deploy`. The `deploy` job (`if: github.ref == 'refs/heads/main'`) SSHes into the Oracle VM (`appleboy/ssh-action`) and runs: `git reset --hard origin/main` → `docker compose -f docker-compose.prod.yml build` → `db:migrate` → `up -d --build` → `docker system prune`.
- It ran **green** for both #24 and #25. #25 deploy at 08:36:18 UTC recreated `legion-emitter` (confirmed in the deploy log). So **no manual rebuild / VM restart is needed** to pick up merged code.
- The deploy **regenerates `.env` from GitHub Secrets every run**, hardcoding `LEGION_EXPECTED_AGENTS=4`, `LEGION_RISK_ENABLED=true`, `LEGION_CRON=0 8,13,20,22,2,4 * * 1-5`, Ollama settings, etc. To tune emitter/gunvest knobs in prod, edit that heredoc in `ci.yml` (not a hand-edited `.env` on the box — it gets overwritten each deploy).
- There are exactly **4 agents** (technical, news, social, contrarian), so `LEGION_EXPECTED_AGENTS=4` is correct. `riskEnabled=true` means a round also needs the risk constraint — if `legion-risk` is ever down, every round leaks (now bounded by the PR #25 sweep, but still worth watching).
- Stale/misleading comment in `ci.yml` above the `deploy` job says "Manual only for now" but the active `if` already enables auto-deploy on main. **Cleanup TODO:** fix that comment (offered, not yet done).

## Open items / TODO at home

1. **Run the `docker stats` command above** — single most important step. Determines whether this is Ollama baseline (likely, no action) or a still-live leak.
2. If Ollama: decide whether to set `OLLAMA_KEEP_ALIVE` to release the model when idle, or accept ~50% flat as normal (it's under the 85% alarm).
3. If still the emitter: check `legion-emitter` logs for the `[emitter] evicted N stale round buffer(s)` warning (confirms the sweep is running) and re-open the investigation. Consider exposing `emitter.stats()` via the existing API (`src/api`, port 8088) as a `/healthz`-style endpoint to watch `pendingRounds`/`pendingCycles` directly.
4. Fix the misleading `deploy` comment in `.github/workflows/ci.yml`.
5. Pre-existing, unrelated: **issue #23** — npm audit vulnerabilities (vitest/vite/esbuild dev chain + node-cron→uuid). Not blocking.

## Reference: related GitHub items

- **PR #24** (merged): GunVest news-timeout hardening (8→15s, macro dedup, env knobs) + retry consolidation onto `p-retry@^6.2.1`.
- **PR #25** (merged): emitter stale-buffer eviction (this memory fix).
- **Issue #26**: memory-leak writeup (has a placeholder for the CPU/Memory screenshots — drag them in via the web UI; API can't upload attachments).
- **Issue #23**: npm audit cleanup (separate).

## Key files

- `src/emit/emitter.js` — the buffers, the sweep, `stats()`.
- `src/run/emitter.js` — wiring; passes `staleEntryMs: cfg.emitter.staleEntryMs`.
- `src/config/index.js` — `emitter.staleEntryMs` (env `LEGION_EMITTER_STALE_MS`, default 1800000).
- `test/emit/emitter.test.js` — eviction + anti-herding-preservation regression tests.
- `.github/workflows/ci.yml` — the auto-deploy job (SSH to Oracle VM).
- `docker-compose.prod.yml` — prod service definitions (`build: .`).
