# ADR 0010 — Vote Contract and Tolerant Parsing

## Status

Accepted (2026-06-04); parser hardened 2026-06-06.

> **Plain-English walkthrough:** [How it works §3 — A vote](../HOW-IT-WORKS.md#3-a-vote).

## Context

The aggregator (ADR 0001) is pure math over structured votes, so every agent must return the
same machine-readable shape. But the producers are small local LLMs that wrap their answer in
prose, code fences, or trailing text, and occasionally malform it. A brittle parser would turn
formatting noise into lost votes and skew consensus.

## Decision

Define one vote contract — `{ agentId, stance ∈ [-2,2], conviction ∈ [0,1], weight, rationale }` —
created and validated in [`src/consensus/vote.js`](../../src/consensus/vote.js), with stance
labels centralized in [`src/consensus/stance.js`](../../src/consensus/stance.js). Agents are
prompted with a shared `RESPONSE_SPEC` ([`src/agents/format.js`](../../src/agents/format.js)).
The parser [`src/agents/parse.js`](../../src/agents/parse.js) extracts the first **balanced**
`{…}` via a string-aware brace scanner (quote/escape aware, so braces inside string values do
not miscount), tolerating fences and surrounding prose and handling nested JSON without
over-grabbing to a trailing brace. On any failure — no JSON, invalid stance/conviction — the
agent **abstains** with HOLD/0 rather than guessing, and the factory tags the reason
(`unparseable vote` vs `data fetch failed: …`) for diagnosis.

## Alternatives considered

- **Greedy `/\{[\s\S]*\}/` regex** — the original; over-grabbed to the last brace and broke on
  trailing content. Replaced by the balanced scanner.
- **Strict JSON-only, reject on any wrapper** — would discard otherwise-valid votes that small
  models wrap in prose, silently shrinking the panel.
- **Function/tool-calling APIs to force JSON** — unavailable/uneven on local Ollama models; the
  tolerant parser is the portable option.

## Consequences

- Formatting noise no longer costs votes; genuine garbage abstains cleanly.
- An abstain is a HOLD/0 vote, so it still participates in dispersion and quorum honestly.
- Ordinal stance + conviction is the single contract the math, persistence, reliability, and
  dashboard all depend on — changing it is a cross-cutting change by design.
