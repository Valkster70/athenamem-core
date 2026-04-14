# MEMORY.md — Quick Reference

*Last updated: 2026-04-14*

This is the lightweight index. For deep knowledge, query AthenaMem or check `memory/YYYY-MM-DD.md`.

---

## Current Active Projects

| Project | Status | Deep Dive |
|---------|--------|-----------|
| **AthenaMem** | ✅ v0.2.0 deployed, GitHub active | KG: `main` wing — architecture, integrations, projects, system_arch |
| OpenClaw 2026.4.12 | ✅ Running | Gateway on :18789 (Athena), :18790 (Hermes) |
| AppSumo Extraction | ✅ Complete | `notes/appsumo-lifetime-deals.md` — 132 products, ~$30K total |

---

## System Architecture — Quick Access

### Network
- **Tailscale**: tail8f7952.ts.net — full mesh VPN
- **Gateway URLs**:
  - Athena: `https://openclaw.tail8f7952.ts.net` (bind=loopback + Tailscale serve)
  - Hermes: `https://hermes.tail8f7952.ts.net`

### Hosts

| Hostname | IP | Purpose | Access |
|----------|-----|---------|--------|
| **Athena** | 100.82.76.83 | Primary OpenClaw | Local + Tailscale |
| **Hermes** | 192.168.0.201 | Remote OpenClaw + OpenFang + Agent Zero | SSH / Tailscale |
| **GEEK25** | 192.168.0.39 | Windows build agent + MCP server | HTTP :8080 / :8081 |
| **VHAOS25** | 192.168.0.58 | Windows build agent | HTTP :8080 |
| **PLEX25** | 192.168.0.188 | Windows build agent | HTTP :8080 |

### Credentials (Trusted Local)

| Service | User / Pass | Notes |
|---------|-------------|-------|
| Hermes SSH | `chris` / `Mercer2011` | Passwordless sudo enabled |
| Agent Zero | `chris` / `Mercer2011` | :5080 on Hermes |
| UGREEN NAS | `chris` / `Gorper01!` | //192.168.0.71/miscellaneous |
| Hostinger FTP | `u130812538` / `Gorper01!` | FTP port blocked from OpenClaw |

---

## Services & Ports

| Port | Service | Host |
|------|---------|------|
| 18789 | OpenClaw Gateway (Athena) | Athena |
| 18790 | OpenClaw Gateway (Hermes) | Hermes |
| 50051 | OpenFang API | Hermes |
| 5080 | Agent Zero Web UI | Hermes |
| 8080 | Windows Agent API | GEEK25, VHAOS25, PLEX25 |
| 8081 | MCP Server (GEEK25) | GEEK25 |
| 8888 | Hindsight API | Athena |
| 9090 | Camera HTTP | Athena |
| 11434 | Ollama API | Athena |
| 50001 | Mnemo Cortex API | Athena |

---

## AI/LLM Configuration

### Primary Model
- **Current**: MiniMax M2.7 via Ollama Cloud
- **Fallbacks**: Kimi K2.5, Gemma4 31B, GLM-5, Qwen 3.5

### OpenFang Agents (Hermes)
| Agent | Model | Purpose |
|-------|-------|---------|
| researcher | qwen3.5:397b-cloud | Deep research |
| assistant | gemma4:31b-cloud | General tasks |
| coder | kimi-k2.5:cloud | Code generation |
| debugger | minimax-m2.7:cloud | Troubleshooting |

---

## Memory Systems Status

| System | Status | Details |
|--------|--------|---------|
| **AthenaMem KG** | ✅ 14 entities, 2 relations, 11 memories | Palace: 2 wings, 6 rooms |
| **qmd** | ✅ 301,742 vectors | 64,413 files indexed |
| **Hindsight** | ✅ Active | :8888, auto-recall enabled |
| **Mnemo Cortex** | ✅ Active | :50001, GPT-4o-mini |
| **LLM Usage** | ✅ Tracking | Web UI on :8080 |

---

## External Integrations

| Service | Status | Config |
|---------|--------|--------|
| Google Fit | ✅ Active | Daily sync ~6:30 AM CT |
| Discord (Zymm) | ✅ Active | Bot: zymm70, ID allowlist enabled |
| Telegram | ✅ Active | @Athena_Valk_Bot, voice enabled |
| Maton.ai | ✅ Configured | Google Drive, OneDrive, Notion, GitHub |
| Tailscale | ✅ Full mesh | All nodes connected |

---

## Key Decisions

1. **AthenaMem as source of truth** — KG + Palace for structured knowledge, daily files for audit trail
2. **Model preference**: Same model/thinking level for sub-agents as main session
3. **Workflow**: Build on Athena, sync to Hermes, push to GitHub
4. **Gateway access**: Tailscale serve (not LAN IP) for remote access

---

## GitHub Repositories

| Repo | URL | Status |
|------|-----|--------|
| athenamem-core | `https://github.com/Valkster70/athenamem-core` | ✅ Private, active |

---

## Open Threads

1. **memoClaw**: Still rate-limited — needs support contact or cooldown
2. **Valk Watch Face**: Design pending via RDP on GEEK25
3. **GEEK25 MCP**: Quick tunnel works but URL rotates on reboot

---

## Emergency Contacts

| What | Command |
|------|---------|
| Hermes SSH | `sshpass -p 'Mercer2011' ssh chris@192.168.0.201` |
| Gateway restart | `openclaw gateway restart` |
| AthenaMem status | `athenamem status` (if CLI) or API call |
| qmd update | `qmd update && qmd embed` |

---

*For everything else — ask AthenaMem or check `memory/YYYY-MM-DD.md`*
