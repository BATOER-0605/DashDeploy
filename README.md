# DashDeploy

Quickly deploy a GitHub repo to a Proxmox VE (PVE) LXC container or QEMU VM at home,
stream the deploy logs, see the target's Tailscale IP, and restore the machine to a
clean snapshot when you're done testing.

Built for the "I'm out, I want to test this Claude Code repo on a real box at home,
fast" workflow.

## How it works

1. Pick a repository and branch (your GitHub PAT lists private repos too).
2. Pick a target server from the dropdown (defined in `config/servers.yml`).
3. Hit **Deploy**. DashDeploy will:
   - start the target guest if it is stopped (PVE API),
   - optionally take a pre-deploy snapshot,
   - SSH in, clone the repo, and `docker compose up -d --build` (or build/run the `Dockerfile`),
   - stream all logs live to the browser (SSE),
   - show the target's **Tailscale IP** and a clickable app link with a health badge.
4. When finished testing, hit **Restore** to roll the target back to its baseline
   snapshot (`clean` by default) via the PVE API.

Targets are expected to have Docker installed and to be joined to your tailnet.
Repos are expected to contain a `Dockerfile` or a `docker-compose.yml`.

## Requirements

- Node.js >= 20
- A Proxmox VE 8 or 9 host with an API token
- One or more LXC/QEMU targets with Docker + Tailscale, each with a baseline snapshot
- A GitHub Personal Access Token with repo read/clone access

## Setup

```bash
npm run setup                       # installs server + web deps
cp .env.example .env                # fill in GitHub PAT + PVE token
cp config/servers.yml config/servers.local.yml   # fill in real targets (gitignored)
npm run build                       # builds web + server
npm start                           # serves the app on $BIND_HOST:$PORT
```

For development with hot reload:

```bash
npm run dev                         # server (tsx watch) + web (Vite proxying /api)
```

### Configuration

- **`.env`** — GitHub PAT, PVE host/token, bind host/port. See `.env.example`.
- **`config/servers.local.yml`** — target inventory. Takes precedence over
  `config/servers.yml` when present. Each entry: PVE node, vmid, `kind` (`lxc`/`qemu`),
  baseline snapshot name, optional app port/health path, and SSH connection
  (password **or** key auth).

### Optional: `.dashdeploy.yml` in your repo

Override the default Docker behaviour per repository:

```yaml
build: docker compose -f docker-compose.prod.yml up -d --build
appPort: 8080
healthPath: /healthz
```

## Security

- DashDeploy is single-user and has **no auth** — run it on the home PVE and bind it
  to the Tailscale interface (`BIND_HOST`) so it is only reachable on your tailnet.
  Never expose it publicly.
- Secrets (`.env`, `config/servers.local.yml`, `data/`) are gitignored. Only the
  sanitized `config/servers.yml` and `.env.example` are committed.
- The GitHub PAT and PVE token never reach the browser; `/api/servers` is sanitized.
  The PAT is scrubbed from log lines before they are persisted or streamed.
- Scope the PVE token minimally: `VM.Audit`, `VM.PowerMgmt`, `VM.Snapshot`,
  `VM.Snapshot.Rollback` on the relevant guests.
- `PVE_TLS_REJECT_UNAUTHORIZED=false` is the default for homelab self-signed certs.

## Tips

- **LXC targets start and roll back markedly faster than QEMU VMs** — prefer LXC for
  fast iteration; reserve VMs for kernel-level needs.
- `warmTargets` in the inventory documents which guests you keep running so deploys
  skip the start step.
- Use **Redeploy** in the history table for one-click re-runs of a previous deploy.

## Tests

```bash
npm test        # server unit tests (PVE client, log line splitter)
```

## Manual end-to-end checklist

- [ ] Deploy to a stopped target — it auto-starts
- [ ] Deploy with "pre-deploy snapshot" enabled — snapshot is created
- [ ] Deploy to a password-auth target and a key-auth target
- [ ] Deploy to an LXC target and a QEMU target
- [ ] Tailscale IP and clickable app link appear on success
- [ ] Reload the page mid-deploy — the SSE log stream replays and continues
- [ ] Redeploy from the history table
- [ ] Restore — target rolls back to its baseline snapshot
- [ ] `GET /api/health` reports GitHub + inventory OK
