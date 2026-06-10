# ADR 0001 — BFT-flavored Leaderless Consensus

## Status

Accepted (2026-06-04).

> **Plain-English walkthrough:** [How it works §4 — Consensus math](../HOW-IT-WORKS.md#4-consensus-math)
> and [§5 — Convergence](../HOW-IT-WORKS.md#5-convergence) (concept first, then the formulas and a worked example).

## Context

Legion must turn `N` independent expert votes into a single trade stance with **no prime
decider**, tolerate a rogue or low-quality agent, and be **deterministic** so every process
that sees the same votes computes the same outcome (state-machine-replication style). The
agents are cooperative and co-located, so the Byzantine threat model of real PBFT (malicious
nodes lying about messages) does not apply — but the *property* we want from BFT (no single
point of decision, bounded influence of any one outlier) does.

## Decision

Adopt a BFT-*flavored* weighted aggregation, computed identically by every node in
[`src/consensus/aggregate.js`](../../src/consensus/aggregate.js). Each agent emits an ordinal
stance `s_i ∈ [-2,2]`, conviction `c_i ∈ [0,1]`, and a rationale. Effective weight is
`W_i = w_i · ρ_i` (static prior × reliability, see ADR 0008). Per round:

- `S_r = Σ(W_i·c_i·s_i) / Σ(W_i·c_i)` — weighted mean stance
- `V_r = Σ(W_i·c_i·(s_i−S_r)²) / Σ(W_i·c_i)` — weighted dispersion
- `κ_r` — weighted fraction of votes whose side agrees with `sign(S_r)`; when `|S_r|` is below
  the hold band, HOLD voters also count as agreeing

A round **converges** iff `κ_r ≥ quorum` (default `2/3`) **and** `V_r ≤ θ_v` (default `0.5`;
later tuned to `0.75` after live analysis — see `CONSENSUS_THETA_V` in `src/config/index.js`).
Up to `R_max = 3` rounds run; between rounds each agent is shown peer dissent and may revise.
If no round converges, the result is `NO_CONSENSUS`/HOLD. Fault tolerance is `f = ⌊(N−1)/3⌋`.

## Alternatives considered

- **Single-arbiter / chairman LLM** — one model reads all opinions and decides. Rejected: a
  prime decider is a single point of failure and is not reproducible.
- **Plain weighted average** — fast, but a confident outlier drags the mean and there is no
  notion of "we disagree too much to act"; the dispersion gate `θ_v` exists precisely to
  preserve honest splits.
- **Raft/Paxos** — solve leader election and log replication, not opinion aggregation; wrong
  tool.

## Consequences

- Consensus is verifiable from the persisted vote log; any node recomputes it.
- A lone outlier can neither force nor block a signal (with `N=4`, three must agree).
- Honest "split" outcomes surface as HOLD instead of a forced trade.
- Cost: multi-round iteration multiplies LLM calls, bounded by `R_max`.
