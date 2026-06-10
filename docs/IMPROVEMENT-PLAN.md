# Legion — Algorithm Review & Improvement Plan

> A critical read of the consensus, reliability, and self-learning subsystems as they
> stand on `main` (2026-06-10), with a prioritized plan to push Legion closer to its
> namesake: a genuinely distributed gestalt where *the agreement is the intelligence*,
> not one model wearing four hats behind a single collector.
>
> This document is **descriptive and forward-looking** — it changes no behavior. Each
> proposal references the exact code it would touch and is sized so it can become its own
> ADR + PR. Read [HOW-IT-WORKS.md](HOW-IT-WORKS.md) first; this assumes it.

---

## 0. Executive assessment

**What is genuinely strong** (keep, don't churn):

- The **consensus core** (`src/consensus/aggregate.js`) is small, pure, and well-tested.
  Separating *lean* (`S`), *dispersion* (`V`), and *directional quorum* (`κ`) into three
  numbers, then gating convergence on **both** a supermajority and low dispersion, is the
  right shape. It correctly refuses to call a loud split a decision.
- The **cold-start discipline** is excellent. Every learned mechanism (ρ, calibration,
  correlation discount, anti-herding) is *neutral by construction* until it has evidence,
  so a fresh deploy behaves like the clean formulas. This is rare and worth protecting.
- The **separation of conviction-as-claimed from conviction-as-scored** (the emitter
  persists RAW conviction for the learner while aggregating CALIBRATED conviction) shows
  real care about feedback loops. `src/emit/emitter.js:199-209`.
- The **loss-asymmetric reliability** (lose trust 2× faster than you earn it, ADR 0017)
  is the correct prior for a system that costs capital when wrong.

**The central gap.** Legion's identity claim is *leaderless* and *diverse*. Two facts
undercut both:

1. **The panel is not diverse where it matters.** All four agents default to the *same*
   local model (`qwen2.5:7b`, every `config.js` ships `provider: 'local'`). Diversity is
   purely prompt-level personas over one 7B brain. Different personas on one model share
   the model's blind spots, tokenizer biases, and failure modes — so the "independent"
   votes are **correlated at the source**, before any of the redundancy machinery sees
   them. The redundancy discount (ADR 0015) measures *behavioral* correlation after the
   fact; it cannot recover independence the architecture never created.

2. **The runtime has a leader.** The math is leaderless, but at runtime a **single
   emitter process** is the sole collector, aggregator, and decider, holding all in-flight
   round state in memory (`rounds` Map, `src/emit/emitter.js:43`). If it restarts
   mid-cycle, every in-flight cycle silently dies — no agent re-publishes. "Any agent can
   crash and restart without anyone caring" is true; the *emitter* cannot. The
   state-machine-replication property (every node recomputes the same answer) is real but
   **unused** — nothing actually runs a second replica.

Everything below is organized to close the gap between the stated ideal and the running
system, plus a set of sharper, lower-risk algorithmic fixes that stand on their own.

---

## 1. Correctness & drift (fix first — cheap, high trust)

### 1.1 Doc/code drift on `θ_v`  *(trivial, do immediately)*

`CONSENSUS_THETA_V` defaults to **0.75** in code (`src/config/index.js:41`) but
HOW-IT-WORKS.md §5 and the §14 cheat-sheet both say **0.5**, and the worked examples
quote "V ≤ 0.5". The qualitative conclusions in the examples still hold at 0.75, but the
single source of truth is wrong about its own default. **Action:** reconcile the doc to
0.75 (or change the default back to 0.5 if 0.5 was intended — decide deliberately and
record which). A reader currently can't trust the cheat-sheet.

### 1.2 The convergence quorum silently degrades under abstention

An abstaining agent emits `stance 0, conviction 0` (`src/agents/factory.js:64`), so its
`W·c = 0` and it drops out of *every* sum. The BFT framing (`f = ⌊(N−1)/3⌋`, single-outlier
tolerance) is stated for `N = 4`, but with one abstention the effective panel is `N = 3`,
where `f = 0` — **a single dissenter can now block, and the "no lone outlier can force or
block" guarantee is gone**, silently. The fraction-based κ self-adjusts numerically, but
the *robustness guarantee* the docs sell does not.

**Action:** make effective panel size explicit. Track `N_eff = count(W·c > 0)` per round;
if `N_eff` drops below a floor (e.g. 3), tag the signal `degraded_quorum` and surface it
on the dashboard and in the Telegram plan. Optionally refuse to emit a non-HOLD call when
`N_eff < 3`. This is honesty about the guarantee, not a math change.

### 1.3 QQQ is captured and stored but never scores

The emitter snapshots `qqq_entry_price` and the resolver computes `qqqReturn`, but
`outcome` is SPY-only (`src/reliability/resolver.js:88`). That's a deliberate
single-benchmark choice (ADR 0008) — fine — but it means a whole column of captured data
is inert. Either (a) document it as display-only and stop implying it matters, or (b) use
it (see §3.3, per-asset benchmark). Pick one; don't leave Schrödinger's benchmark.

---

## 2. Consensus algorithm — sharper, still leaderless

### 2.1 The redundancy discount is a heuristic, not an independence estimate  *(ADR 0015 successor)*

Today each agreeing vote is divided by `mass = 1 + Σ max(0, corr)` over the coalition
(`directionalQuorum`, `src/consensus/aggregate.js:47-55`). Three problems:

- **Pearson over a 5-point ordinal scale with `MIN_CORR_PAIRS = 5` is extremely noisy.**
  A single co-extreme pair of votes can swing the correlation; an agent that always votes
  the same stance has *undefined* correlation (zero variance → `pearson` returns null) and
  is treated as fully independent, which is backwards — a constant voter is maximally
  redundant, not maximally independent.
- **The `mass` denominator is not a principled effective-sample-size.** For `k` agents
  mutually correlated at `r`, each gets `mass = 1 + (k−1)r`, so the coalition contributes
  `k / (1 + (k−1)r)` — a reasonable shape, but it double-counts because each member
  discounts against *all* others including ones already discounted. It is not the number
  of effective independent voices.
- **It only fires post-hoc**, and only on agreement, never tightening dispersion.

**Proposal — effective number of independent voices via the correlation matrix.** Build
the coalition's weighted correlation matrix `Σ` (shrunk toward the identity at low sample
count, à la Ledoit–Wolf), and use the participation-ratio / eigenvalue estimate of
*effective rank*:

```
N_eff = (Σ λ_i)² / Σ λ_i²        # participation ratio of the correlation eigenvalues
discount_factor = N_eff / N_coalition
```

Scale the coalition's summed `W·c` by `discount_factor`. This degrades gracefully
(identity matrix → `N_eff = N`, no discount), handles the constant-voter case correctly
(zero-variance series → perfectly correlated with anything sharing its pattern → collapses),
and is a single, defensible scalar instead of a per-pair heuristic. Keep the cold-start
shrinkage so it stays neutral until enough shared signals exist.

### 2.2 Convergence ignores conviction *magnitude* of the winning side

`κ` measures *how much weight* is on the winning side and `V` measures spread, but neither
asks whether the winners are *confident*. A panel where everyone weakly leans BUY at
conviction 0.3 converges identically to one where everyone screams STRONG_BUY at 0.95 — same
κ, similar V — yet the second is a far stronger call. The magnitude survives only into the
final `conviction = min(|S|/2, 1)`. That's *okay*, but it conflates "the panel is sure" with
"the panel agrees on a strong stance."

**Proposal (optional, measure first):** report a fourth diagnostic, **agreement strength**
`A = mean(c_i | agreeing side)`, alongside S/V/κ. Don't gate on it yet — log it, surface it,
and check whether low-A converged signals underperform high-A ones in the resolver. If they
do, add `A ≥ a_min` as a third convergence condition. This is the disciplined way to add a
gate: instrument, then gate.

### 2.3 Anti-herding guard can't see *direction flips*, only late convergence

The guard (`src/emit/emitter.js:135-145`) fires only when a round `> 1` converges, checking
round-1 independent backing for the *converged* side. It cannot catch the case where the
panel's **lean itself migrates** across rounds toward the loudest agent without the
round-1-backing test tripping (because backing is measured for the final side, which may
have had a thin-but-≥priorQuorum minority). Consider also logging **per-agent vote drift**
(`Σ |s_i,round_r − s_i,round_1|`) and flagging cycles with high aggregate drift but low
new-evidence — a cheap herding smell test that complements the backing gate.

---

## 3. Self-learning & evaluation — the part with the most headroom

This is where Legion is least "Legion." Today learning turns **four scalar volume knobs**
(ρ and cal per agent). The agents themselves never learn — they have no memory of being
wrong. A true gestalt improves its *reasoning*, not just the mixer.

### 3.1 The binary outcome throws away most of the signal  *(highest-leverage learning fix)*

`outcome = forwardReturn > spyReturn ? 1 : 0` (`src/reliability/resolver.js:88`). Beating
SPY by 1bp and by 20% are the *same* outcome; a near-miss and a disaster are the *same*
miss. With a 5-day horizon and 4-hourly cycles, the per-agent resolved sample is small and
the binary label is mostly noise — so ρ and cal move on thin evidence. ADR 0017 explicitly
deferred graded outcomes because "a graded outcome would break the binary hit/miss the
calibration discriminator relies on." That's a real constraint, but it's solvable:

- Keep a **binary `hit`** for the calibration discriminator (it genuinely needs two
  classes), **and** add a continuous **`alpha = forwardReturn − spyReturn`** stored per
  resolved signal.
- Drive ρ from a **continuous proper score** rather than a binary Brier. Replace the
  binary Brier with a **standardized-alpha Brier or a log-score on a magnitude-aware
  probability**: map the vote to an *expected alpha* `μ_i = f(s_i, c_i)` and score against
  realized alpha with a scale-normalized loss (e.g. `(μ_i − alpha/σ)²` where `σ` is the
  ticker's realized vol, already computed by the Technical agent). This rewards an agent
  that is right *and big* and punishes confident *and* large misses harder — exactly the
  loss-aversion ADR 0017 wants, but now sensitive to magnitude.
- Keep the result clamped/neutralized identically so cold-start behavior is unchanged.

This is the single change most likely to make ρ informative within a reasonable number of
resolved signals.

### 3.2 ρ and calibration both reward discrimination and *multiply* — compounding risk

ρ scales `w_i` (range [0.5, 1.5]) and cal scales `c_i` (range [0.5, 1.5]); they multiply
into effective influence, so one agent's swing is **0.25× to 2.25×** on top of its domain
prior — a 9× spread driven by the *same* underlying outcomes (ADR 0014 admits the overlap).
In a short 50-signal window during a trending regime, a few correlated wins inflate ρ and
cal together and let one agent dominate the panel — precisely the single-decider failure the
design is trying to avoid, arrived at by a back door.

**Proposal:**
- **Shrink both toward 1.0 with a Bayesian estimator**, not just a clamp. A Beta-Binomial
  posterior on hit-rate (or a Normal-Normal on standardized alpha) pulls low-sample agents
  toward neutral and only lets a *consistently* sharp agent reach the extremes. The clamp
  is a guard rail; shrinkage is the right prior.
- **Bound the combined multiplier**, e.g. cap `ρ_i · cal_i ∈ [0.4, 2.0]`, so no single
  agent can exceed ~2× the panel on a streak regardless of how the two factors align.

### 3.3 Reliability is regime-blind  *(toward "truly Legion")*

ρ is a single lifetime-ish scalar (recency-decayed, but unconditional). Yet an agent good in
trends is often bad in chop; the Contrarian should be *more* trusted at crowded extremes and
*less* mid-range. Collapsing this into one number averages away the agent's actual edge.

**Proposal — conditional reliability.** Bucket resolved forecasts by a coarse **market
regime** (e.g. VIX tertile × SPY-trend sign — both already available) and learn ρ/cal *per
regime*. At cycle time, the emitter picks the bucket matching current conditions. This is
the difference between "News is a 1.1× agent" and "News is a 1.4× agent into earnings-driven
tape and 0.8× in macro chop." Start with 2–4 buckets and the same shrinkage so sparse
buckets stay neutral. This also unlocks a real **per-asset / per-sector benchmark** (§1.3):
score a defensive name against a defensive benchmark, not SPY.

### 3.4 The agents never see their own track record  *(the deepest "self-learning" gap)*

Right now "self-learning" is entirely external: outcomes turn volume knobs, but each agent's
*prompt* is static and amnesiac. Legion-from-Mass-Effect improves by *reasoning better*, not
by being turned up. Two concrete, additive mechanisms:

- **Outcome-grounded memory (retrieval-augmented self-critique).** Persist, per agent, a
  small library of its resolved calls with the realized alpha and a one-line post-mortem.
  At gather time, retrieve the `k` most *similar* past situations (same regime / similar
  indicator profile) and inject them: *"Last 3 times you called STRONG_BUY on high-RSI
  momentum into elevated VIX, you were wrong by −4% vs SPY."* This is few-shot self-
  correction with real ground truth, and it changes the *vote*, not just its weight.
- **A periodic meta-reflection pass.** On the reliability cron, run a cheap LLM pass per
  agent over its recent misses to propose a *prompt patch* (a sentence appended to its
  system prompt), gated behind human review or A/B'd against the unpatched prompt via the
  forward paper-test before promotion. This is how the gestalt edits *itself* instead of
  waiting for an operator.

### 3.5 Learn the domain priors `w_i`, don't hand-set them

`w_i` (1.0/1.2/0.8/0.9) are fixed human guesses (the `config.js` comments admit it). ρ
already corrects for skill, but it's clamped to [0.5, 1.5] around a *fixed* prior, so a
badly-set `w_i` is only half-correctable. Once enough history exists, **fit `w_i` from the
data** (the prior is just the long-run, regime-averaged reliability) on a slow cron, with
heavy shrinkage toward the hand-set value so it can't run away at low volume. Keeps the
hand-tuned cold-start, lets the system outgrow it.

### 3.6 A constant/degenerate agent is nearly invisible to the learner

An agent that always votes BUY/0.7 has zero variance: it never enters correlation (pearson
→ null → treated independent, §2.1), and it only loses ρ if its constant call happens to be
wrong often. It contributes to S and κ while carrying **zero information**. Add an explicit
**information check**: per agent, the entropy / variance of its recent stances. A
near-constant voter gets a neutrality penalty (its conviction discounted toward 0) until it
demonstrates it's actually reading the data. This is cheap and catches a stuck/lazy model
that Brier alone is slow to demote.

---

## 4. Agent diversity — making the panel actually independent

This is the root cause behind §0 gap #1 and the ceiling on everything in §3.

### 4.1 Heterogeneous model pool (the single most important change)

Four personas on one `qwen2.5:7b` is one brain arguing with itself. The provider seam is
*already built for this*: `resolveProvider` knows about `gemini` and `openai`
(`src/llm/provider.js:14-18`) and the dashboard can set per-agent provider/model — but
`createProvider` only implements `'local'`, so any non-local choice throws. **Finish the
seam:** implement at least one second provider family and **assign different base models to
different agents** (e.g. Technical on a code/math-leaning model, News on a long-context
model, Contrarian on a different family entirely). Even running the *same* local model at
**different temperatures/seeds per agent** is a strictly cheaper first step that buys real
sampling diversity tonight. Independence at the *source* is what makes the diverse-panel
thesis true rather than aspirational — and it's what the redundancy discount (§2.1) is
quietly trying to compensate for.

### 4.2 Data-level overlap is unmeasured

Technical and Contrarian both consume VIX; News and Contrarian both consume macro;
Social and Contrarian both consume per-ticker sentiment (`gather.js` across agents). Shared
*inputs* drive correlated *outputs* independent of the model. Worth an explicit audit and,
where overlap is high, deliberately narrowing each agent's data aperture so the lenses are
actually distinct.

### 4.3 The roster is static; a gestalt should grow and prune

`docs/adding-an-agent.md` makes adding an agent easy, but there's no *mechanism* for the
system to spawn a specialist (e.g. an options-flow agent, an insider-transaction agent) or
retire one whose ρ sits at the floor for months. A long-term "Legion" should manage its own
roster: auto-retire chronically floored agents (with a human confirm) and flag coverage gaps
where the panel is consistently uncertain.

---

## 5. Runtime architecture — closing the "leaderless" gap

### 5.1 The emitter is a single point of failure dressed as leaderless

All round state lives in one process's memory (`src/emit/emitter.js:43-48`). The
state-machine-replication property is implemented in the *math* but never *exercised* —
there's one collector. **Two paths, pick per appetite:**

- **Pragmatic (recommended first):** make the emitter **crash-recoverable**. Persist
  in-flight round buffers (or rebuild them by replaying the bus / a JetStream durable
  consumer) so an emitter restart resumes in-flight cycles instead of silently dropping
  them. This removes the "fragile heart" without changing the model.
- **Purist (true to the namesake):** run **N aggregator replicas** that each independently
  consume the vote stream and compute the signal; emit only when a quorum of *aggregators*
  agree on the same signal (they will, given the deterministic math — so disagreement
  becomes a *liveness/health* alarm, not a correctness one). This finally *uses* the
  replication property the design has paid for in discipline but never cashed in. This is
  the architecture that earns the word "leaderless."

### 5.2 Re-gathering data every round is wasteful and can self-contaminate

`handleCycle` calls `gather()` on every round (`src/agents/factory.js:37`). Market data
doesn't meaningfully change within a minutes-long cycle, so rounds 2–3 re-pay the data-fetch
cost and, worse, can pull a *different* snapshot mid-cycle if a feed ticks — making the
debate argue over shifting facts. **Cache the round-1 gather for the cycle** and re-feed it
with the dissent block; the only thing that should change between rounds is the *argument*,
not the *world*.

---

## 6. Risk manager — deterministic is good, static is not

`computeConstraint` uses hard-coded VIX 30/40 and an 8% daily-move trip
(`src/risk/rules.js:4-6`). An 8% move in a low-vol utility is a five-sigma event; in a meme
stock it's noise. The constraint should be **volatility-normalized**: trip on
`|move| ≥ k · σ_ticker` using the realized vol the Technical agent already computes, not a
flat percentage. Same for the VIX caps — consider the VIX *percentile* over a trailing
window rather than absolute levels that drift with the vol regime. Keep it deterministic and
LLM-free (ADR 0011 is right); just make the thresholds relative.

---

## 7. Prioritized roadmap — implementation status (2026-06-10)

All rows below have been implemented (one commit each, ADRs 0018–0028) unless marked
*deferred*. Each row is a self-contained ADR + commit.

| # | Change | Status |
|---|--------|--------|
| **P0** | §1.1 θ_v doc/code drift; §1.2 `N_eff`/degraded-quorum tagging; §1.3 QQQ display-only | ✅ done (docs + `effectivePanel`/`CONSENSUS_MIN_PANEL`) |
| **P0** | §5.2 cache per-cycle gather | ✅ done (per-cycle TTL cache in the agent factory) |
| **P1** | §3.1 magnitude-aware graded reliability | ✅ done — ADR 0018 (tanh-graded alpha + Brier *skill score* baseline) |
| **P1** | §4.1 heterogeneous models / per-agent sampling | ✅ done (per-agent temperature+seed; OpenAI-compatible provider family for `openai`/`gemini`) |
| **P2** | §3.2 shrinkage + combined-multiplier cap | ✅ done — ADR 0019 (Kish-ESS `n/(n+10)` shrinkage; ρ·cal ∈ [0.4, 2.0]) |
| **P2** | §2.1 effective-voices redundancy | ✅ done — ADR 0020 (participation ratio via Frobenius norm) |
| **P3** | §3.3 regime-conditional reliability | ✅ done — ADR 0023 (calm/stressed VIX buckets, overlay with fallback). *Per-asset benchmark deferred* — it changes outcome semantics (ADR 0008 comparability) and deserves its own decision. |
| **P3** | §5.1 crash-recoverable emitter | ✅ done — ADR 0024 (pending-state mirror + replay). *Replicated aggregators (purist) deferred.* |
| **P4** | §3.4 outcome-grounded memory + meta-reflection | ✅ done — ADR 0025 (graded track record in prompts) + ADR 0026 (flag-gated lesson distillation, default off) |
| **P4** | §3.5 learn `w_i` | ✅ measured-not-applied — ADR 0027 (long-window learned prior on the leaderboard; blending awaits observed divergence) |
| **P4** | §4.3 dynamic roster | ✅ done — ADR 0028 (floored-streak review flag; never auto-retires) |
| **P4** | §3.6 information check | ✅ done — ADR 0021 (stance-variance conviction discount) |
| **P4** | §2.2 agreement strength | ✅ measured-not-gated (A persisted per round/signal; gate awaits resolver evidence) |
| **P4** | §6 vol-normalized risk | ✅ done — ADR 0022 (3σ-of-this-name trip, flat-8% fallback). *VIX percentile deferred (needs stored VIX history).* |
| — | §4.2 data-aperture audit | ✅ done (ARCHITECTURE §2 table + aperture rule) |
| — | §2.3 vote-drift herding telemetry | *deferred* — complements the backing gate; instrument when herding blocks appear in practice |

**Still open, in recommended order:** replicated aggregators (the purist leaderless
runtime, on top of ADR 0024); per-asset/sector benchmarks; the A-gate and `w_i` blend once
their measurements accumulate; similarity-retrieved memory episodes (the stronger ADR 0025);
VIX-percentile risk; §2.3 drift telemetry.

---

## 8. What I would *not* change

- The three-number consensus core and the dual convergence gate — correct and legible.
- Cold-start neutrality everywhere — protect this invariant in every proposal above.
- Loss-asymmetry in ρ — the right prior; keep it when moving to graded scoring.
- Risk as a non-voting brake that can shrink/veto but never flip — leaderless purity.
- The RAW-vs-calibrated conviction split in the emitter — load-bearing anti-feedback design.

Resisting churn on what already works is half of good engineering. The plan above adds and
sharpens; it does not rewrite the parts that are right.
