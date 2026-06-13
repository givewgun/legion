# ADR 0024 — Crash-Recoverable Emitter

## Status

Accepted (2026-06-10). First step of removing the emitter as a hidden single point of
failure; replicated aggregators remain a future decision.

> **Plain-English walkthrough:** [How it works §2 — The one cycle](../HOW-IT-WORKS.md#2-the-one-cycle-start-to-finish).

## Context

The consensus *math* is leaderless (any node recomputes the same S/V/κ from the same
votes — ADR 0001), but the *runtime* had a leader: one emitter process held every
in-flight round buffer, the round-1 priors for the herding guard, and the per-cycle
learned dials, all in memory. "Any agent can crash and restart without anyone caring" was
true; the emitter could not. A restart mid-cycle silently dropped every in-flight cycle —
no signal, no `NO_CONSENSUS`, no forecast snapshot — and a restart between rounds left
the herding guard blind (missing priors).

## Decision

Mirror the in-memory buffers in two pending tables and replay them on start:

- **Write path.** Every arriving vote/constraint is upserted into
  `legion.pending_votes` / `legion.pending_constraints` *fire-and-forget* — the hot path
  never blocks on, or fails because of, the mirror.
- **Recovery.** `start()` subscribes first (no live message is missed), then loads
  pending rows younger than `staleEntryMs`: rebuilds round buffers (deduped by agent
  against votes that raced in live), restores **round-1 priors** for the herding guard,
  and processes any round that is now complete. `start()` returns the recovery promise.
- **Post-round replay.** A round that was already aggregated (`roundExists`) is not
  simply skipped: the crash may have landed *between* persisting the round and acting on
  it, which would otherwise strand the cycle (agents never re-vote on their own).
  Recovery inspects the persisted state and replays the missing action:
  - cycle no longer `running` → only tidy the pending rows;
  - persisted round **not final** → re-publish round+1 with the pending votes as
    dissent (correct even if the original republish went out — the agents' replies
    landed in a dead subscription and are gone), dropping any partial pre-crash
    round+1 buffer so fresh votes form a clean round;
  - persisted round **final**, signal already emitted → just `finishCycle` (never emit
    twice);
  - persisted round **final**, no signal → replay the finalize tail. The persisted
    round votes are the exact calibrated aggregation inputs (ADR 0001's replication
    property), and the recorded `converged` flag — which already reflects the herding
    guard's decision — is honored, not re-derived. A pending risk constraint lost in
    the crash finalizes unconstrained with a loud warning.
- **Lifecycle.** A cycle's pending rows are deleted on finalize; the stale sweep ages out
  rows past `staleEntryMs` so an abandoned cycle cannot resurrect on the next restart.
  Both aging and recovery judge recency per *cycle*, not per row (a cycle with any
  recent row in either pending table keeps — and reloads — all of its rows): a slow
  batch legitimately spreads one round's votes past `staleEntryMs`, and the early
  votes plus the one-shot risk constraint must survive a restart or the cycle is
  stranded until the stale sweep times it out.
- **Herding-guard priors are now the RAW round-1 votes** (not the calibration-scaled
  copies): "independent backing" means the agents' own pre-dissent claims, and raw votes
  are what the pending table can faithfully restore. (With neutral dials the two are
  identical; with learned dials the guard now measures unscaled backing — a deliberate
  semantic choice, not an accident of recovery.)
- All pending-state repo methods are optional (`repo.savePendingVote?.` etc.), so
  memory-only deployments and existing tests run unchanged.

## Alternatives considered

- **NATS JetStream durable consumers** — replay from the bus instead of a table; heavier
  operational change (JetStream enablement, stream config) for the same outcome, and the
  DB is already the system of record.
- **Replicated aggregators with quorum-of-aggregators emit** — the "purist" leaderless
  runtime; valuable, but recovery is the prerequisite either way and the replica protocol
  deserves its own ADR.
- **Do nothing (rely on the 4h cadence)** — a crash mid-cycle loses at most one cycle per
  ticker, but it also silently loses forecasts the learner needed, and "the heart is
  fragile but beats rarely" is not an availability story.

## Consequences

- An emitter restart resumes in-flight cycles: complete rounds emit, partial rounds wait
  for their remaining votes, the herding guard keeps its memory, and a crash at any point
  *after* round persistence (before the republish, before `addSignal`, or between
  `addSignal` and `finishCycle`) is replayed idempotently instead of stranding the cycle.
- Two small tables of transient rows; steady-state size is bounded by in-flight cycles.
