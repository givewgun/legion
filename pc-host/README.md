# Legion home-PC model server

Turn this Windows PC (RTX 5060 Ti) into Legion's preferred model server: it serves
a big model (`gpt-oss:20b`) over Tailscale when it's awake and you're not using it,
self-wakes ~10 min before each market cycle, and sleeps back when idle. Legion falls
back to the Oracle VM's `qwen2.5:7b` whenever this PC is asleep, busy, or off.

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
HOME_MODEL=gpt-oss:20b
HOME_THINK=false
```

Then **restart Ollama** (quit the tray app and relaunch, or reboot) so the localhost
binding + keep-alive take effect.

## Verify it works

On this PC (should report `ready=true` when you're not touching it):

```powershell
Invoke-RestMethod http://localhost:11435/ready
```

From the Oracle VM (on the tailnet) — lists models when idle, returns 503 when you're
gaming / actively using the PC:

```bash
curl http://<this-pc-tailscale-ip>:11435/api/tags
```

Behaviour checklist:

- **PC asleep** → VM's probe fails fast (~1.5s) → cycle runs on Oracle. No hang.
- **PC awake + idle** → cycle runs on `gpt-oss:20b`. Confirm on the VM:
  `psql "$DATABASE_URL" -c "SELECT DISTINCT model FROM legion.signal_votes;"`
- **You're gaming / working** → sidecar returns 503 → cycle runs on Oracle. You're
  never interrupted, even if you forget the dashboard toggle.
- **Dashboard toggle OFF** ("Use home PC model") → cycle runs on Oracle regardless.

## Tuning

Re-run `setup.ps1` with parameters to change behaviour:

```powershell
# wider "busy" guard, sleep sooner, different model
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -IdleThresholdSec 600 -SleepTimeoutMin 30 -Model qwen3:14b
```

- `-IdleThresholdSec` — seconds of no input before "not busy" (default 300).
- `-VramThresholdMiB` — non-Ollama VRAM that counts as busy (default 2000).
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
