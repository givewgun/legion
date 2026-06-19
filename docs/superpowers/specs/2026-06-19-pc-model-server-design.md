# PC as Preferred Model Server for Legion — Design

**Date:** 2026-06-19
**Status:** Approved (brainstorm), pending spec review
**Branch:** `claude/pc-model-server`

## Goal

Route Legion's LLM calls to a home PC (Ryzen 5 7600, RTX 5060 Ti 16GB, 32GB DDR5)
running a larger/better model when it is available, and fall back to the Oracle VM's
`qwen2.5:7b` otherwise. The PC manages its own wake/prime/sleep lifecycle. A cycle
must never block, slow, or fail because the PC is asleep, busy, or off.

## Non-goals

- True remote on-demand wake (Wake-on-LAN over the internet). Deferred — see Phase 4.
  No always-on LAN device exists to emit the magic packet, and the PC (the thing asleep)
  cannot wake itself remotely. Self-wake + opportunistic covers the realistic cases now.
- Warm-start / cross-model transfer of ρ. A new model starts neutral (see Reliability).
- Replacing Oracle's Ollama. The VM remains the always-available fallback.

## Architecture — two planes

### Routing plane (legion code — the only substantive code change)

Extend the existing `local` provider into a **tiered provider**:

- **Primary tier:** PC Ollama over Tailscale — `{ HOME_OLLAMA_URL, HOME_MODEL }`.
- **Fallback tier:** Oracle Ollama — the current `{ OLLAMA_URL, OLLAMA_MODEL }`.

Behavior:

- **Health-gated, fail-fast.** Before routing to the PC, probe the PC-side readiness
  sidecar (see below) with a short timeout (~1.5s), result cached briefly (~60s). Probe
  fails or reports not-ready → use Oracle immediately. A sleeping/absent PC never causes
  a multi-minute hang.
- **Per-request failover.** If a PC `generate` call errors or times out mid-cycle, that
  call retries on Oracle. A PC that sleeps mid-sweep degrades gracefully; the cycle
  completes on Oracle.
- **Backwards compatible.** If `HOME_OLLAMA_URL` is unset, the provider behaves exactly
  as today (pure Oracle). This means Phase 1 code ships safely before any PC setup exists.

The tiered provider exposes which model/tier actually served each call so the vote can be
tagged (see Reliability).

### Lifecycle plane (PC-side — no legion control code)

- **Wake:** Windows Task Scheduler tasks with "Wake the computer to run this task,"
  scheduled ~10 minutes before each cron cycle window.
- **Prime:** an on-wake task sends a warmup `generate` and sets `OLLAMA_KEEP_ALIVE` long
  enough to cover the whole sweep (~60–90 min, aligned with the emitter stale-entry
  window of 90 min). Model is resident in VRAM before the cycle begins. The prime task
  **respects the busy-check** (below) — it will not warm the model onto a GPU you are
  actively using.
- **Sleep:** Windows power policy sleeps on idle (e.g. 20 min). This naturally respects
  active use (the PC will not sleep while you are working). `keep_alive` expiry unloads
  the model and frees VRAM between cycles.

## Connectivity — Tailscale mesh

- VM and PC join the same tailnet. Ollama is reachable only at the PC's stable `100.x`
  address (or MagicDNS name, e.g. `pc.<tailnet>.ts.net:11434`). Never exposed to the
  public internet.
- A Tailscale ACL restricts `:11434` and the readiness sidecar port to the VM node only.
  Ollama's lack of built-in auth is acceptable inside the private, ACL-scoped mesh.
- **Docker reach (implementation detail to resolve in the plan):** legion agents run in
  Docker on the VM. Run `tailscaled` on the VM host and have containers route to the
  tailnet via the host. If host routing proves awkward, fall back to a Tailscale sidecar
  container. The plan must verify one approach end-to-end.

## Busy-check — readiness sidecar

A small HTTP server on the PC, part of the self-managed lifecycle. Legion's health gate
probes **it** instead of raw `/api/tags`. The busy logic lives on the PC, where GPU and
input state are observable; legion stays dumb and only reads `ready`.

**Rule:**

> **BUSY if** recent user input (`< N` min, via Win32 `GetLastInputInfo`)
> **OR** a fullscreen/exclusive app is foreground
> **OR** non-Ollama GPU VRAM usage exceeds a threshold (via `nvidia-smi` per-process,
> excluding `ollama`).
> **READY** only when all three are clear.

Rationale:

- **Idle-time** is the core signal. When the PC self-woke for a cycle, nobody has touched
  it → idle → ready → serve. When you are at the keyboard (gaming *or* any intense CPU
  work) → recent input → busy → Oracle. This generalizes beyond GPU work and covers the
  "forgot the kill switch" case automatically.
- **Fullscreen + VRAM** cover AFK-gaming: you step away mid-match, idle climbs, but a game
  is still foreground / holding VRAM — without these, legion would grab the GPU and cause
  a stutter when you return.

Response shape: `{ ready: boolean, reason: string, gpuFreeMiB: number, idleSec: number }`.
Legion uses `ready`; the rest is for diagnostics/dashboard. All thresholds are tunable.

## Dashboard toggle — kill switch / manual override

- A global **"Use home PC model"** toggle on the dashboard config page.
- Persisted in DB. A new `legion.runtime_config` key-value table (e.g.
  `key = 'home_pc_enabled'`) is the planned home; the plan may instead reuse an existing
  config mechanism if one fits better.
- **Health gate = toggle ON AND sidecar ready AND probe reachable.** Toggle OFF → skip the
  PC entirely (pure Oracle). This is the manual override layered on top of the automatic
  busy-check.

## Model

- Default: **`gpt-oss:20b` (MXFP4, ~12–13GB VRAM)** — strongest reasoning at the ~12GB
  budget, fits the 16GB card with headroom. Tunable via `HOME_MODEL`.
- **Reasoning-model caveat:** gpt-oss is a reasoning model — it emits thinking/analysis
  tokens that must NOT reach `parseVote`. Mitigation (plan to verify against Ollama's
  gpt-oss behavior): set `HOME_THINK=false` to suppress reasoning where the API honors it,
  AND add a defensive reasoning-strip (e.g. drop `<think>…</think>` / harmony analysis
  channel) in the parse path as a backstop. The existing `think` config plumbing
  (`OLLAMA_THINK`) is the model for the new `HOME_THINK`.

## Reliability — per-(agent, model) segmentation (Phase 1, not deferred)

The learned dials are *applied* at vote-aggregation time in the emitter
(`scaleWeights(votes, rho)` / `scaleConviction`, today keyed by `agent_id`) and *measured*
by `recomputeReliability` from `signal_votes` joined to resolved `signals`. Segmentation
threads the producing model through that entire loop:

- **Persist:** the in-flight vote payload carries the served model (agent → NATS →
  emitter). The emitter persists it to a new **`signal_votes.model`** column — this is the
  resolved-forecast source the learner reads. (`votes.model` on the per-round audit table
  is optional/nice-to-have; `signal_votes.model` is required.) The served-model string is
  the Ollama model name (`HOME_MODEL` when the PC served, `OLLAMA_MODEL` when Oracle did);
  the tiered provider reports which.
- **Measure:** `legion.agent_reliability` PK `(agent_id)` → **`(agent_id, model)`**. All its
  dials (rho, calibration, info_factor, learned_prior, roster streak) are computed per
  `(agent, model)`. `recomputeReliability` buckets by `(agent_id, model)`;
  `getResolvedForecasts` and `getAgentBoardRows` SELECT `sv.model`.
- **Apply:** the emitter loads ρ/calibration/info as `[agentId][model]`-keyed maps;
  `scaleWeights`/`scaleConviction` look up by each vote's own `(agent, model)`. A failover
  cycle that mixes models weights each vote by the right model's ρ.
- **Regime/correlation:** key `agent_regime_reliability` by `(agent_id, model)` too. Regime
  buckets need `MIN_RESOLVED` depth to persist; split by model they are sparse early and
  simply fall back to the base `(agent, model)` ρ — consistent keying, graceful degradation.
- **Cold-start:** a new `(agent, model)` with no resolved history defaults to **ρ = 1.0
  (neutral)** and re-learns over ~`MIN_RESOLVED` samples. Switching models resets that
  agent's learned skill for the new model — the honest cost of pure per-model measurement.
  No warm-start in v1.
- **Backfill:** existing `signal_votes` rows predate the column → backfill `model` with the
  current Oracle model (`OLLAMA_MODEL`, e.g. `qwen2.5:7b-instruct`), so historical ρ stays
  attributed to the model that actually produced it.
- Surface the per-model dial on the dashboard reliability board.

## Edge cases / pitfalls (designed-for)

1. **PC off / RTC wake didn't fire** → fail-fast probe → Oracle. No hang.
2. **Windows wake-timer gotchas** — fast-startup / hybrid sleep and the "Allow wake timers"
   power setting can silently block RTC wake; S3 sleep vs S4 hibernate behave differently.
   Power settings must be configured explicitly. Covered by the runbook + verification.
3. **PC sleeps mid-sweep** → per-call failover, mixed-model cycle; each vote is weighted by
   its own model's ρ. Acceptable.
3b. **Reasoning tokens leak into parse** → `HOME_THINK=false` + defensive strip in parse.
3c. **New model neutral period** → after a model switch, that model's votes carry ρ=1.0
    until ~`MIN_RESOLVED` resolved signals accrue. Expected, not a bug.
4. **Active use / gaming / intense work** → busy-check routes to Oracle automatically;
   dashboard toggle is the manual backstop.
5. **Reliability cron** also uses `local`; at post-close the PC is likely asleep → Oracle
   fallback. Fine.
6. **Security** — tailnet-private + ACL scoped to the VM node.

## Testing

- **Unit (mock `fetchImpl`):** probe-ready → PC; probe-down/timeout/not-ready → Oracle;
  mid-call PC failure → Oracle; served-model tag matches the served tier; `HOME_OLLAMA_URL`
  unset → pure-Oracle no-op.
- **Config:** new env parsed (`HOME_OLLAMA_URL`, `HOME_MODEL`, `HOME_THINK`, probe timeout);
  absent = today's behavior.
- **Vote payload** carries served model; emitter persists `signal_votes.model`.
- **Reliability segmentation:** `recomputeReliability` buckets by `(agent, model)`;
  upsert/read by `(agent, model)`; emitter weights each vote by its own `(agent, model)` ρ;
  cold-start `(agent, new-model)` → ρ=1.0; backfill defaults legacy rows to `OLLAMA_MODEL`.
- **Parse:** reasoning/thinking tokens stripped before `parseVote` produces a vote.
- **No automated test** for wake/Tailscale/sidecar OS integration (infra) → manual runbook
  + verification checklist instead.

## Phasing

1. **Legion code** — tiered `local` provider + health gate + config + dashboard toggle +
   per-(agent, model) reliability segmentation (`signal_votes.model`, `agent_reliability`
   /`agent_regime_reliability` re-keyed, emitter per-model dial lookup, backfill) +
   reasoning-token strip + tests. Ships now; routing is a no-op until the PC is configured,
   but segmentation is live immediately (every vote tagged with its served model).
2. **Infra runbook** — Tailscale on VM + PC + ACL; install Ollama on PC + pull model; set
   `HOME_OLLAMA_URL`. Verify Docker→tailnet reach.
3. **PC lifecycle** — readiness sidecar; RTC wake task; busy-aware prime task; power/sleep
   policy; `keep_alive`. Verification checklist.
4. **Later (optional)** — WoL helper (old phone / Pi Zero 2 W / ESP32) for true remote
   wake; warm-start ρ transfer across models if the neutral cold-start period proves costly.
