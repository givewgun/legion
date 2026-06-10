# ADR 0026 — Meta-Reflection: Lessons Distilled from Misses

## Status

Accepted (2026-06-10). Builds on ADR 0025 (outcome-grounded memory). **Off by default**
(`LEGION_REFLECTION=true` enables it).

> **Plain-English walkthrough:** [How it works §10 — Learning who to trust](../HOW-IT-WORKS.md#10-learning-who-to-trust).

## Context

ADR 0025 shows an agent its raw graded record; the agent still has to re-derive the
pattern behind its misses every cycle, inside a prompt budget. And the reliability dials
only make a repeatedly-wrong agent *quieter* — nothing in the loop ever states what it
should do *differently*.

## Decision

A reflection pass on the reliability cron ([`src/reliability/reflect.js`](../../src/reliability/reflect.js)):

- per agent, fetch its recent **directional misses** (graded wrong vs SPY, with stance,
  conviction, regime, and realized alpha);
- with at least `MIN_MISSES = 3`, ask the LLM for **one concrete lesson** (two sentences
  max, pattern-across-misses, capped at 300 chars);
- persist it (`legion.agent_lessons`, one row per agent, newest wins) and inject it into
  the agent's future prompts alongside the track record ("Lesson you drew from your
  recent misses: …").

Safety properties:

- **gated** — off unless `LEGION_REFLECTION=true`, because it puts an LLM in the cron;
- **grounded** — the input is only verified outcomes; the lesson cannot cite wins or
  invent trades it never made;
- **bounded** — one short lesson per agent, overwritten each pass; no accretion of
  self-modifying prompt text;
- **non-fatal** — reflection failures log and skip; resolve/recompute never depend on it.

## Alternatives considered

- **LLM-proposed system-prompt patches with human review / A-B promotion** — the full
  self-editing loop; needs experiment infrastructure to be honest about whether a patch
  helps. The single-lesson design is the safest increment and reuses the forward
  paper-test as its eventual judge.
- **Deterministic lesson templates ("you were wrong N times on momentum buys")** — never
  hallucinate, but can only restate the record (ADR 0025 already shows it); the LLM adds
  the generalization step.
- **Reflect every cycle** — expensive and noisy; misses accrue on resolution timescales,
  so the reliability cron is the natural cadence.

## Consequences

- A persistently wrong agent now receives an explicit, regenerated-as-evidence-changes
  instruction about its failure pattern — reasoning-level feedback to complement the
  weight-level dials.
- The lesson is itself LLM output injected into prompts; the 300-char cap, single-row
  overwrite, and miss-only grounding bound the blast radius, and the flag keeps it
  opt-in until the forward paper-test shows it earns its cost.
