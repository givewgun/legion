# ADR 0001 — BFT-flavored Leaderless Consensus

## Status

Accepted (2026-06-04).

## Context

Legion must reach a single trade stance from N independent expert agents with no prime
decider, must tolerate a rogue/outlier agent, and must be deterministic so every node
computes the same result from the same votes. True adversarial PBFT is overkill: agents are
cooperative and co-located.

## Decision

Adopt a BFT-_flavored_ aggregation computed identically by every node. Each agent emits an
ordinal stance `s_i ∈ [-2,2]`, conviction `c_i ∈ [0,1]`, and rationale. Effective weight
`W_i = w_i · ρ_i`. Per round compute weighted stance `S_r`, weighted dispersion `V_r`, and
directional quorum `κ_r`. Converge iff `κ_r ≥ 2/3` AND `V_r ≤ θ_v` (default 0.5). Fault
tolerance `f = ⌊(N−1)/3⌋`. Up to `R_max = 3` rounds with forced dissent exposure between
rounds; unconverged → `NO_CONSENSUS`/HOLD.

## Consequences

- No leader, no single point of decision; consensus is verifiable from the vote log.
- A lone outlier can neither force nor block a signal (with N=4, need 3 agreeing).
- Honest "split" outcomes are preserved instead of forcing a trade.
- ρ_i (Brier-tuned) lets the gestalt learn whom to trust over time.
- Cost: multi-round iteration multiplies LLM calls (bounded by R_max).
