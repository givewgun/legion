# Legion home-PC model server

Turn this Windows PC (RTX 5060 Ti) into Legion's model server: it serves a capable
reasoning model (`qwen3:14b`) over Tailscale when it's awake and you're not using it,
self-wakes ~10 min before each market cycle, and sleeps back when idle. Legion is
**PC-preferred** — whenever the PC is available it commits to it (queuing if busy),
and only falls back to the Oracle VM's `qwen2.5:7b` when the PC is asleep, busy, or
off. The PC is faster than the VM, so a loaded PC queues rather than spilling the
sweep to Oracle.

`qwen3:14b` (~9 GB) fits the 16 GB card with room for two KV-cache slots, so
`setup.ps1` sets `OLLAMA_NUM_PARALLEL` (default 2) and the GPU serves two agents
**concurrently** instead of serializing one slow 20B call. Tune `-Model` /
`-NumParallel` if you change cards.

These four scripts are the whole PC side. You run **one** of them.

| File | What it is |
|------|------------|
| `setup.ps1` | One-shot installer. Run it once (and again after US DST changes). |
| `readiness-sidecar.ps1` | The always-on gate Legion talks to. Auto-started by setup. |
| `prime.ps1` | Warms the model on wake. Run by the wake tasks setup creates. |
| `legion-pc-common.ps1` | Shared config + busy-detection. Don't run directly. |

## Prerequisites

1. **Ollama** installed and on PATH — https://ollama.com/download (leave its
   "start at login" default ON so it comes back after a reboot).
2. **Tailscale** installed and logged in on BOTH this PC and the Oracle VM
   (`tailscale up`), so they share a tailnet. Lock it down with an ACL that lets
   only the VM reach this PC's gate port (see the bottom of this file).
3. **NVIDIA driver** with `nvidia-smi` on PATH (standard with the GeForce driver).

## Install (one command, elevated)

Open PowerShell **as Administrator**, `cd` into this folder, and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

That pulls the model, binds Ollama to localhost, enables wake timers, sets a 60-min
sleep timeout, opens the gate port to the tailnet only, registers the sidecar to
auto-start, and creates the two RTC-wake tasks (10:50 & 16:50 ET → your local time).

When it finishes it prints the three env vars to put on the **Legion** side (`.env`):

```
HOME_OLLAMA_URL=http://<this-pc-tailscale-ip>:11435
HOME_MODEL=qwen3:14b
HOME_THINK=true
```

Then **restart Ollama** (quit the tray app and relaunch, or reboot) so the localhost
binding + keep-alive take effect.

## Verify it works

On this PC (should report `ready=true` unless a game/render is using the GPU —
ordinary browsing/typing still reports `ready=true`):

```powershell
Invoke-RestMethod http://localhost:11435/ready
```

From the Oracle VM (on the tailnet) — lists models when free, returns 503 when the
GPU is busy (fullscreen app, high non-Ollama VRAM, or a `-BusyProcesses` match):

```bash
curl http://<this-pc-tailscale-ip>:11435/api/tags
```

Behaviour checklist:

- **PC asleep** → VM's probe fails fast (~1.5s) → cycle runs on Oracle. No hang.
- **PC awake, GPU free** → cycle runs on `qwen3:14b`, even while you browse/type.
  Confirm on the VM:
  `psql "$DATABASE_URL" -c "SELECT DISTINCT model FROM legion.signal_votes;"`
- **You're gaming / GPU-heavy work** → sidecar returns 503 → cycle runs on Oracle.
  Detected by fullscreen, non-Ollama VRAM > threshold, or a named busy process.
- **Dashboard toggle OFF** ("Use home PC model") → cycle runs on Oracle regardless.

## Stopping / decommissioning

Three levels, least to most destructive — pick by how long you're stepping away.

**1. Pause for now (no PC change, instant, reversible).**
Turn OFF "Use home PC model" on the dashboard config page. Legion immediately routes
every cycle to the Oracle VM. The PC still wakes/serves nothing for Legion until you
turn it back on. Best for "not today" / debugging.

**2. Stop serving but keep it installed.**
Disable the sidecar + wake tasks without uninstalling — they're easy to re-enable:

```powershell
# elevated
Get-ScheduledTask | Where-Object { $_.TaskName -like 'Legion *' } | Disable-ScheduledTask
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -like '*readiness-sidecar.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Re-enable later with `... | Enable-ScheduledTask` (then reboot, or run the sidecar
task). Or just leave the dashboard toggle OFF (level 1) — simpler.

**3. Full decommission (undo everything `setup.ps1` did).**

```powershell
# elevated
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
# add -RevertPower to also disable wake timers + reset the sleep timeout
# add -RemoveModel to also delete qwen3:14b (~9 GB)
```

It stops + removes the sidecar and wake/prime tasks, deletes the firewall rule,
clears the `OLLAMA_HOST` / `OLLAMA_KEEP_ALIVE` / `OLLAMA_NUM_PARALLEL` env (Ollama
returns to defaults after a restart), and deletes the generated config. By default it
leaves your power settings
and the model alone (they're shared / a big re-download) — use the flags above to also
revert those.

After uninstall, on the **Legion** side, stop routing to the PC either way:
turn the dashboard toggle OFF, or remove `HOME_OLLAMA_URL` (and `HOME_MODEL` /
`HOME_THINK`) from `.env` and redeploy. Either makes the tiered `local` provider
pure-Oracle again — Legion keeps running on `qwen2.5:7b` exactly as before this feature.

Optional cleanup outside these scripts: remove the PC from your Tailscale ACL/tailnet,
and `ollama` itself if you don't use it for anything else.

## Tuning

Re-run `setup.ps1` with parameters to change behaviour:

```powershell
# tighter "busy" guard, sleep sooner, different model, block while a game runs
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -VramThresholdMiB 3000 -SleepTimeoutMin 30 -Model qwen3:14b -BusyProcesses Cyberpunk2077,obs64
```

- `-VramThresholdMiB` — non-Ollama VRAM that counts as busy (default 4000). Light
  desktop/browser use sits well under this; a game/render trips it.
- `-BusyProcesses` — process names (no `.exe`) that mark the box busy whenever they
  run, regardless of VRAM/fullscreen (default none).
- `-SleepTimeoutMin` — idle minutes before sleep (default 60; raise toward 90 if
  you want the wake to absorb a full ±1h US-DST drift without re-running setup).
- `-CycleTimesEt` — ET cycle times; must match Legion's `LEGION_CRON`
  (default `@('11:00','17:00')`).

## "Why is it asleep during a cycle?"

- **Full shutdown (S5)**: RTC wake can't fire from a powered-off box. Use sleep or
  hibernate, never shutdown. (Hibernate/S4 is fine — wake works; the model reloads
  on the prime warmup.)
- **US DST changed**: the local wake times drift 1h vs ET. Re-run `setup.ps1`.
- **"Allow wake timers" got disabled**: re-run `setup.ps1`.

## Tailscale ACL (paste into your tailnet policy)

Only the Oracle VM should reach this PC's gate. Tag the PC `tag:legion-pc` and the
VM `tag:legion-vm`, then:

```jsonc
{
  "acls": [
    { "action": "accept", "src": ["tag:legion-vm"], "dst": ["tag:legion-pc:11435"] }
  ]
}
```

Ollama itself listens only on `127.0.0.1:11434`, so the sidecar on `11435` is the
only thing reachable over the tailnet — and only by the VM.
