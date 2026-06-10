# ADR 0021 — Information Check (constant voters lose voice)

## Status

Accepted (2026-06-10). Complements ADR 0014/0019/0020.

> **Plain-English walkthrough:** [How it works §10 — Learning who to trust](../HOW-IT-WORKS.md#10-learning-who-to-trust).

## Context

An agent that always votes the same stance (a stuck model, a degenerate prompt, a feed
that flatlined) carries **zero information** yet is nearly invisible to every existing
dial:

- its zero stance variance makes its Pearson correlation **undefined**, so the quorum's
  redundancy discount (ADR 0015/0020) reads it as fully *independent* — backwards;
- Brier only dents it if its one stuck call is reliably wrong, which a perma-BUY agent in
  a bull tape is not;
- calibration needs both hits and misses to move, which a constant voter may never supply.

Meanwhile it contributes full weight to `S` and `κ` every cycle.

## Decision

Learn a per-agent **information factor** from the same resolved-forecast window:

- `stanceVariance` — decay-weighted variance of the agent's recent stances;
- `informationFactor = clamp(variance / 0.25, 0.25, 1)` — full voice at or above the
  reference variance (an agent that at least occasionally moves a notch), falling
  linearly to a 0.25 floor for a perfectly constant voter; neutral `1.0` below
  `MIN_RESOLVED` (cold start must not punish a young agent).

The factor is persisted on `agent_reliability.info_factor` and applied by the emitter as
a multiplier on the **conviction** term alongside calibration (`c'_i = c_i · cal_i ·
info_i`): cal asks "is its confidence meaningful", info asks "is anyone home".

## Alternatives considered

- **Stance entropy instead of variance** — equivalent signal for a 5-point ordinal scale;
  variance is simpler and already has the decay-weighted machinery.
- **Fold into calibration** — muddies a legible statistic; a constant voter's problem is
  not mis-calibrated confidence, it's absent discrimination.
- **Hard-mute constant voters** — a stuck agent may recover (feed restored, model
  swapped); a floored discount keeps it audible enough to re-earn voice as variance
  returns, without a special re-admission path.

## Consequences

- A stuck/lazy agent loses up to 75% of its conviction influence within one reliability
  recompute after `MIN_RESOLVED`, instead of riding `S` and `κ` at full weight for weeks.
- An agent with genuine but *stable* conviction in a one-direction regime is partially
  discounted too — accepted: a voter that never moves over 50 resolved signals is not
  reading the data, whatever the regime.
- Cold-start behaviour is unchanged.
