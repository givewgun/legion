# ADR 0003 — Pluggable LLM Provider Abstraction

## Status

Accepted (2026-06-04); extended 2026-06-07 (per-agent runtime switching, Phase 5).

## Context

Runtime cost must be ≈$0 by default, but accuracy sometimes warrants a hosted model. Different
agents may warrant different models, and operators should be able to switch a model without a
redeploy. The rest of the system must not know or care which provider answered.

## Decision

A factory in [`src/llm/provider.js`](../../src/llm/provider.js), `createProvider(name, cfg)`,
returns an object with a single `generate({ system, prompt }) → string` method. Today only
`local` (Ollama, see ADR 0005) is implemented; `gemini`/`openai` are reserved names. A router,
`resolveProvider({ provider, model }, factory)`, maps a stored config to an instance, fills
`DEFAULT_MODELS[provider]` when no model is given, and falls back to `local` for unknown names.

Per-agent provider/model/enabled live in `legion.agent_config` and are surfaced through
`GET/PATCH /api/agents` and the dashboard **Agents** tab. The agent factory accepts an optional
`getProvider({ agentId })` resolved **per cycle**, so a UI change takes effect on the next
evaluation; a disabled agent abstains (HOLD/0) without an LLM call. The injected-`provider`
path is unchanged when `getProvider` is absent, preserving earlier behaviour.

## Alternatives considered

- **Hard-code Ollama** — simplest, but blocks any future quality/cost trade-off and couples
  every agent to one runtime.
- **One global provider, env-switched** — cheaper to build, but cannot vary by agent and needs
  a redeploy to change.
- **LangChain-style adapter layer** — far more surface than a single `generate` method needs.

## Consequences

- Default deploy is free (local Ollama); paid providers are strictly opt-in per agent.
- Operators tune cost/accuracy live from the dashboard once wiring lands (see below).
- Adding a provider = one branch in `createProvider` + a `DEFAULT_MODELS` entry.
- **Known gap:** `getProvider` is not yet wired into the `src/run/agent-*.js` entrypoints, and
  `gemini`/`openai` are not yet implemented — selecting them would throw at cycle time (the
  agent then abstains). Storage, API, UI, and factory support exist; the live wiring and the
  hosted providers are tracked follow-ups.
