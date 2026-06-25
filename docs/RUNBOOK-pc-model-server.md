# Runbook: PC Model Server (Tailscale + Ollama + Readiness Sidecar)

This runbook documents the operator setup for routing Legion inference to a home PC
running Ollama when the PC is idle and available, with automatic fail-over to the
Oracle VM's local model when the PC is busy or asleep.

> **The PC side is now turnkey scripts — start at [`pc-host/README.md`](../pc-host/README.md).**
> Run `pc-host/setup.ps1` once (elevated); it pulls the model, configures power/wake
> timers, opens the firewall, and registers the readiness sidecar + RTC-wake tasks.
> This runbook below is the conceptual reference behind those scripts.
>
> **Port model (resolves the earlier ambiguity):** Ollama binds **`127.0.0.1:11434`**
> (localhost only — never on the tailnet). The readiness sidecar is the sole
> tailnet-facing process on **`:11435`** and reverse-proxies to Ollama, returning 503
> when the PC is busy. Set `HOME_OLLAMA_URL=http://<pc-tailnet-ip>:11435` on Legion,
> and the Tailscale ACL to `dst: ["tag:legion-pc:11435"]`.

---

## 1. Tailscale Setup and ACL

### 1.1 Install Tailscale

**On the Oracle VM host (the Docker host):**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --authkey=<YOUR_AUTHKEY>
```

**On the gaming PC:**

Download and install from https://tailscale.com/download/windows, then:

```powershell
tailscale up
```

Record the PC's Tailscale address — either the `100.x.x.x` IP or its MagicDNS
hostname (e.g. `pc.tail1234.ts.net`). This will be the `HOME_OLLAMA_URL` host.

### 1.2 ACL Stanza (Tailscale Admin Console)

Restrict the PC's Ollama port (11434) and the readiness sidecar port (default 8765)
to the Oracle VM node only — no other device should be able to reach these ports:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:legion-oracle"],
      "dst": ["tag:legion-pc:11434", "tag:legion-pc:8765"]
    }
  ],
  "tagOwners": {
    "tag:legion-oracle": ["autogroup:admin"],
    "tag:legion-pc":     ["autogroup:admin"]
  }
}
```

Tag the Oracle VM as `tag:legion-oracle` and the PC as `tag:legion-pc` in the
Tailscale admin console.

---

## 2. Docker → Tailnet Reach Verification

By default the Legion containers run in Docker's bridge network and reach the
host's Tailscale interface through host routing. Verify reachability from inside
a running container:

```bash
docker exec legion-agent-news \
  wget -qO- http://<pc-tailnet-host>:11434/api/tags
```

Expected output: a JSON object listing available Ollama models.

### 2.1 Fallback: Sidecar Network Namespace

If host routing does not reach the tailnet from inside containers (e.g. the VM
runs network isolation), add a Tailscale service to `docker-compose.prod.yml` and
have the agent containers join its network namespace:

```yaml
services:
  tailscale:
    image: tailscale/tailscale:stable
    environment:
      - TS_AUTHKEY=${TAILSCALE_AUTHKEY}
      - TS_STATE_DIR=/var/lib/tailscale
    volumes:
      - tailscale-state:/var/lib/tailscale
      - /dev/net/tun:/dev/net/tun
    cap_add:
      - NET_ADMIN
    restart: unless-stopped

  legion-agent-news:
    network_mode: "service:tailscale"
    # ... rest of service definition

volumes:
  tailscale-state:
```

With this layout every agent container uses the `tailscale` container's network
stack, which includes the Tailscale interface.

---

## 3. PC Ollama: Install, Model, and VRAM

### 3.1 Install Ollama

Download from https://ollama.com/download/windows. After installation, Ollama
starts automatically and listens on `localhost:11434`.

### 3.2 Pull the Model

```powershell
ollama pull qwen3:14b
```

This downloads the `qwen3:14b` model. Verify it is listed:

```powershell
ollama list
```

### 3.3 VRAM Headroom

`qwen3:14b` (~9 GB) still leaves room on the 16 GB card for idle driver overhead
(~1–2 GB) and two parallel KV-cache slots — that headroom is what lets
`OLLAMA_NUM_PARALLEL` (section 3.5) serve two agents at once instead of one slow
20B call at a time. If other applications consume significant VRAM the readiness
sidecar (section 4) will detect this and hold the PC as BUSY.

### 3.4 Set OLLAMA_KEEP_ALIVE

The model should stay loaded in VRAM between Legion inference calls to avoid
repeated load latency. Set this in Ollama's Windows service environment:

```powershell
# Add to the Ollama system service environment (via Windows Services GUI
# or the registry key for the Ollama service):
OLLAMA_KEEP_ALIVE=90m
```

Alternatively, the prime task (section 6) sends a warmup generate with
`keep_alive: "90m"` in the request body, which overrides the global setting
for that session.

### 3.5 Set OLLAMA_NUM_PARALLEL

Unlike the CPU-only Oracle box (which runs `OLLAMA_NUM_PARALLEL=1` so each
inference gets all cores), the PC GPU has the VRAM to serve two agents at once.
`setup.ps1` sets this to `2` in the Ollama machine environment:

```powershell
OLLAMA_NUM_PARALLEL=2
```

With `qwen3:14b` two of a ticker's agents generate concurrently; the rest queue
behind these slots. Legion is PC-preferred, so a busy PC queues rather than
spilling the sweep to Oracle — `HOME_TIMEOUT_MS` (default 60 min) is sized to
outlast a deep queue. Raise `NUM_PARALLEL` only if you free VRAM (smaller model);
a larger model that crowds VRAM risks KV-cache eviction or OOM (watch the Ollama
log).

---

## 4. Readiness Sidecar

The readiness sidecar is a small HTTP server running on the PC. The Legion
probe issues `GET /ready` against `HOME_OLLAMA_URL`; the sidecar answers with
`{ ready, reason, ... }` (it never proxies that path). Legion commits to the PC
only on `ready: true`; `ready: false` (busy-gated) or any network/timeout error
(PC offline) falls through to the Oracle model.

**Two isolated listener pools (why `/ready` is fast under load).** `/ready` and
`/api/*` are served by **separate** HttpListener + worker pools on the one port
(HTTP.sys routes by path prefix). A long `/api/generate` holds a proxy worker for
minutes, so during a full sweep every proxy worker can be busy — but the dedicated
health pool keeps `/ready` answering in milliseconds. This is what makes "PC busy
serving other votes" mean **wait/queue on the PC**, not fall back to Oracle:
fallback now happens only when the PC is genuinely unavailable (offline or
busy-gated), never when it is merely saturated with votes.

`/api/tags` is still proxied (and busy-gated) for the model-list dropdown
(`GET /api/settings/pc-models`), but it is no longer the routing probe.

### 4.1 Busy Criteria

The sidecar returns BUSY (and blocks `/api/tags` with `503`) when **any** of the
following conditions hold:

| Condition | Implementation |
|---|---|
| Recent user input | `GetLastInputInfo` Win32 API: idle seconds < 10 min (600 s) |
| Fullscreen/exclusive app | `GetForegroundWindow` + `GetWindowRect` vs display rect, or DXGI `IDXGIOutput::GetDisplayModeList` exclusive mode |
| Non-Ollama VRAM usage | `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader`: exclude PIDs whose image is `ollama.exe`; if remaining usage > threshold (e.g. 2 GB) → BUSY |

### 4.2 Response Diagnostic Shape

A `GET /ready` endpoint (or `/api/tags` when `200`) returns:

```json
{
  "ready": true,
  "reason": "idle",
  "gpuFreeMiB": 12800,
  "idleSec": 1240
}
```

When BUSY:

```json
{
  "ready": false,
  "reason": "active_user_input",
  "gpuFreeMiB": 6400,
  "idleSec": 45
}
```

Possible `reason` values: `"idle"`, `"active_user_input"`, `"fullscreen_app"`,
`"gpu_busy"`.

### 4.3 How `/ready` (routing probe) and `/api/*` Are Gated

```
GET /ready  (health pool — never proxied, never blocked by a generate)
  → sidecar checks busy flags
  → always HTTP 200 { ready: <bool>, reason, ... }

GET /api/tags | POST /api/generate  (proxy pool)
  → sidecar checks busy flags
  → if BUSY:  HTTP 503 {"ready":false,"reason":"..."}
  → if READY: proxy → http://127.0.0.1:11434/... → return response
```

Legion's `tieredProvider` commits to the PC only when `/ready` returns
`ready: true`; `ready: false` or a network/timeout error both fall through to
the Oracle model. Because the health pool is isolated, a deep generate queue
no longer times the probe out — a saturated PC is queued on, not abandoned.

### 4.4 Binding and Firewall

Bind the sidecar to the Tailscale interface IP (`100.x.x.x`) only, not
`0.0.0.0`, so it is unreachable from outside the tailnet:

```powershell
# Example (Node.js sidecar):
server.listen(11434, '100.x.x.x')
```

The Windows Firewall rule should allow inbound TCP 11434 from the Tailscale
subnet (`100.64.0.0/10`) only.

---

## 5. RTC Wake (Task Scheduler)

The PC must be in a low-power sleep/hibernate state (S3 or S4), **not** fully
shut down (S5), for RTC wake to work.

### 5.1 Configure Power Plan

```powershell
# Set idle-sleep timeout (20 min on AC power — see section 7)
powercfg /change standby-timeout-ac 20

# Allow hibernate after sleep (S3 → S4 after additional time)
powercfg /change hibernate-timeout-ac 120

# NEVER auto-shutdown — S5 cannot be woken by RTC
# (Ensure "Turn off the display" is set, not "Shut down")
```

### 5.2 Allow Wake Timers

```powershell
# Enable wake timers on the active power plan
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /setactive SCHEME_CURRENT
```

Or via Group Policy: Computer Configuration → Administrative Templates →
System → Power Management → Sleep Settings → **Allow wake timers** = Enabled.

### 5.3 Task Scheduler Wake Task

Create one scheduled task per Legion cron window. Example for a 06:00 UTC
window (adjust for local timezone):

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c echo wake"
$trigger = New-ScheduledTaskTrigger -Daily -At "06:00AM"
$settings = New-ScheduledTaskSettingsSet -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "LegionWake-0600" `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited
```

The trigger fires ~10 minutes before the Legion cron window so the model has
time to load before the first vote lands.

### 5.4 S3 / S4 vs S5

| Power state | RTC wake | Notes |
|---|---|---|
| S3 (sleep) | **Yes** | RAM powered, fast resume (~5 s) |
| S4 (hibernate) | **Yes** | RAM to disk, slower resume (~30 s) |
| S5 (shutdown) | **No** | Full power off; RTC wake not supported |

Configure power to `sleep → hibernate`, never auto-shutdown.

---

## 6. Busy-Aware Prime Task

On each RTC wake event, before Legion's cron window opens, run a prime task
that checks the sidecar's `/ready` endpoint. If idle, it sends a warmup
generate to Ollama to pre-load the model into VRAM:

```powershell
# prime.ps1
$ready = (Invoke-RestMethod http://100.x.x.x:11434/ready).ready
if (-not $ready) { exit 0 }  # Gaming or active — skip; Legion will fall back to Oracle

$body = @{
  model      = "qwen3:14b"
  prompt     = "Hello"
  keep_alive = "90m"
  stream     = $false
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:11434/api/generate `
  -Body $body -ContentType "application/json"
```

Register this as a scheduled task triggered ~5 minutes before the Legion cron
window (i.e. after the wake task fires):

```powershell
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File C:\legion\prime.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At "05:55AM"
$settings = New-ScheduledTaskSettingsSet -WakeToRun:$false -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "LegionPrime-0600" `
  -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited
```

---

## 7. Windows Idle Sleep

After each Legion cron window the PC should return to low-power state
automatically. With a 20-minute idle-sleep timeout:

```powershell
powercfg /change standby-timeout-ac 20
```

When Ollama is done serving requests and no other activity keeps the PC awake,
it will enter S3 after 20 minutes. The `OLLAMA_KEEP_ALIVE` expiry (90 min in
the warmup request) will unload the model from VRAM before the next wake cycle,
preventing stale VRAM allocation.

---

## 8. Legion Environment Variables

Set these in `.env` or the Docker Compose `environment:` block for the agent
and emitter services:

| Variable | Example | Effect |
|---|---|---|
| `HOME_OLLAMA_URL` | `http://pc.tail1234.ts.net:11434` | URL of the sidecar-fronted Ollama on the PC. **Leave unset to disable the feature entirely.** |
| `HOME_MODEL` | `qwen3:14b` | Model name passed to Ollama on the PC. |
| `HOME_THINK` | `true` | `qwen3` is a reasoning model — keep `true`; its `<think>` tokens are stripped before parsing. Set `false` only for a non-thinking model. |
| `HOME_PROBE_TIMEOUT_MS` | `1500` | Timeout for the `/ready` probe (default 1.5 s). Tune up if the PC wakes slowly. |
| `HOME_TIMEOUT_MS` | `3600000` | Per-call PC inference deadline (default 60 min). PC-preferred commits to the PC and queues, so this must outlast a deep `NUM_PARALLEL` queue rather than aborting into an abstain. |

When `HOME_OLLAMA_URL` is absent, the provider skips the PC path and uses the
Oracle model exclusively. When the PC is configured and available the provider
**commits** to it (queuing if busy); Oracle serves only when the probe reports the
PC unavailable — there is no mid-call failover.

---

## 9. Verification Checklist

Run these checks in order after deploying.

### 9.1 PC Asleep → Oracle Fail-Fast

1. Put the PC to sleep (`Start → Power → Sleep`).
2. Trigger a Legion cron cycle manually or wait for the next scheduled run.
3. Confirm the probe times out quickly (within `HOME_PROBE_TIMEOUT_MS` ms) and
   does not stall the cycle.
4. Confirm the signal is produced using the Oracle model (check agent logs for
   the Oracle model name, not `qwen3:14b`).

### 9.2 PC Awake + Idle → Votes Tagged `qwen3:14b`

1. Ensure the PC is awake and no user is active (wait for idle timeout or use
   the prime task to confirm readiness).
2. Trigger a Legion cycle.
3. After the cycle completes, run:

   ```sql
   SELECT DISTINCT model FROM legion.signal_votes
   ORDER BY 1;
   ```

   Expected output includes `qwen3:14b`.

### 9.3 Gaming / Active → BUSY → Oracle

1. Launch a fullscreen game or any GPU-heavy application on the PC.
2. Trigger a Legion cycle.
3. Confirm the sidecar returns `503` (check the sidecar logs or run
   `curl http://<pc-tailnet>:11434/api/tags` from the Oracle VM).
4. Confirm Legion falls through to the Oracle model (votes show the Oracle
   model name, not `qwen3:14b`).

### 9.4 Dashboard Toggle OFF → Oracle Even When PC Is Ready

1. With the PC awake and idle, use the Legion web dashboard settings page to
   **toggle `home_model_enabled` OFF**.
2. Trigger a cycle.
3. Confirm votes use the Oracle model despite the PC being available.
4. Toggle the setting back ON and confirm the PC model resumes in the next cycle.

### 9.5 New (Agent, Model) ρ Starts at 1.0 and Moves After MIN_RESOLVED

1. Switch `HOME_MODEL` to a new model name (e.g. `qwen3:14b`).
2. Trigger several cycles; confirm votes are tagged with the new model.
3. Before `MIN_RESOLVED` (= 5) forecasts resolve, query:

   ```sql
   SELECT agent_id, model, rho, sample_size
   FROM legion.agent_reliability
   WHERE model = 'qwen3:14b';
   ```

   `rho` should be `1.0` and `sample_size` should be `0` (no resolved
   forecasts yet — cold start stays neutral).

4. After at least 5 forecasts resolve (after `horizonDays` calendar days),
   re-query. `rho` will now be non-neutral and `sample_size` ≥ 5, showing the
   reliability learner has incorporated evidence.
