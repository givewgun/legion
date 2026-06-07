# Adding a Legion Agent

A Legion agent is one process built from four small parts plus a roster entry. The
consensus core never changes — agents are pure data + a persona.

## 1. The four module parts

Create `src/agents/<name>/`:

| File        | Responsibility                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `config.js` | Exports `{ id, weight }` — the agent id and its static prior weight `w_i`.                                            |
| `gather.js` | Exports `gather(gunvest, symbol)` → a plain data object pulled from GunVest endpoints. No LLM, no consensus.          |
| `prompt.js` | Exports `buildPrompt(symbol, data, peers)` → the persona + `RESPONSE_SPEC` + optional `dissentBlock(peers)`.          |
| `index.js`  | Wires the above into `createAgent({ id, weight, gather, buildPrompt, bus, gunvest, getProvider })` and `start()`s it. |

Reuse `src/agents/format.js` (`RESPONSE_SPEC`, `dissentBlock`) and `src/agents/parse.js`
(`parseVote`) — do not re-implement the JSON contract or parsing.

## 2. Register in the roster

Add `{ id: '<name>', weight: <w_i> }` to `ROSTER` in `src/api/routes/agents.js` and add a
run entrypoint `src/run/agent-<name>.js` plus a service in `docker-compose.yml`
(copy an existing agent service, change the command).

Set `expectedAgents` in the emitter env to the new voting-agent count so the emitter waits
for every vote before aggregating.

## 3. Weight and reliability

`weight` is the static prior `w_i`. Effective weight is `W_i = w_i · ρ_i`, where `ρ_i`
starts at 1.0 and is tuned by the Phase 4 Brier loop once the agent's signals resolve.
Pick `w_i` ≈ 1.0; raise it only if the agent's domain is unusually load-bearing.

## 4. Consensus impact

Adding a voting agent changes `N`, which changes fault tolerance `f = ⌊(N−1)/3⌋` and the
quorum threshold `κ ≥ 2/3`. Going from 4 → 5 voting agents raises the agreeing-weight
needed for the 2/3 directional **quorum** and changes how many outliers the gestalt
tolerates. Prefer odd `N` to avoid ties at the band edge. Re-check `θ_v` (dispersion cap)
after adding an agent whose stance distribution is wide.

## 5. Provider

The agent inherits per-agent provider switching for free via `getProvider({ agentId })`
(Phase 5). Its default provider is `local`; change it at runtime on the **Agents** tab.
