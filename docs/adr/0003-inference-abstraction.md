# ADR 0003 — Pluggable LLM Provider Abstraction

## Status

Accepted (2026-06-04).

## Context

Runtime cost must be ≈$0 by default, but accuracy sometimes warrants a hosted model. Each
agent may want a different provider, and operators should switch without redeploying.

## Decision

A `src/llm/provider.js` factory exposes `createProvider({ type, model })` for `local`
(Ollama, default), `gemini`, and `openai`, all behind a `generate(prompt)` interface.
`resolveProvider({ provider, model })` fills `DEFAULT_MODELS` and defaults unknown names to
`local`. Per-agent provider/model live in `legion.agent_config` and are resolved **per
cycle** by the agent factory's `getProvider({ agentId })`, so a UI change takes effect on the
next evaluation. Disabled agents abstain without an LLM call.

## Consequences

- Default deploy is free (local Ollama); paid providers are strictly opt-in per agent.
- Operators tune cost/accuracy live from the dashboard.
- Local ARM inference is slow (~5–10 tok/s) — acceptable for batch cadence.
- Adding a provider = one branch in the factory + a default model entry.
