# Research: Mnemo Cortex — Sidecar Memory Coprocessor

**Source:** https://github.com/GuyMannDude/mnemo-cortex  
**Stars:** 34 | **License:** MIT | **Language:** Python (80%), Shell (12%), TypeScript (2%)  
**Version:** v2.3.2  
**Status:** Active, production use on multiple agents (Rocky: 6 weeks recall, Alice: 1 week)

---

## Core Innovation

Mnemo Cortex is a **sidecar** — it runs outside the agent process, watching session files from the outside. This means:
- Agent crashes don't lose memory
- No agent code modifications needed
- If Mnemo crashes, agent keeps working independently

The sidecar pattern is the key insight: **memory should be decoupled from the agent runtime**. Memory is infrastructure, not agent logic.

```
OpenClaw Agent ──writes──▶ Session Tape (disk)
                                │
                          Watcher Daemon ──reads──▶ Mnemo SQLite
                                                        │
                          Refresher Daemon ◀──reads─────┘
                                │
                          writes──▶ MNEMO-CONTEXT.md ──▶ Agent Bootstrap
```

---

## Architecture Details

### Session Tape → Mnemo Flow
1. **Watcher Daemon** — tails the agent's session JSONL file, reads new messages as they arrive
2. **Ingest** — writes messages to SQLite with timestamps, session IDs, speaker (user/agent/tool)
3. **Compaction** — periodically runs LLM-backed compaction on older messages
4. **Refresher** — periodically reads compacted context back into a `MNEMO-CONTEXT.md` file
5. **Bootstrap** — agent reads `MNEMO-CONTEXT.md` on startup

### Compaction (DAG-Based)
- **Level 0**: Raw messages (immutable, full verbatim)
- **Level 1**: Leaf summaries (first pass — ~30% token reduction, near-verbatim)
- **Level 2**: Condensed summaries (second pass — ~80% reduction)
- **Level 3**: Active frontier (what the agent loads at bootstrap)

**Every compacted node tracks its source nodes** — agent can always expand back to verbatim.

### Health Monitoring
Built-in `mnemo-cortex health` command checks:
- API server status and response time
- Database state (hot/warm/cold sessions)
- Compaction model availability
- Agent recall functionality
- Watcher daemon status
- MCP registration

14/14 checks pass or it alerts.

---

## Data Structures

### SQLite Schema (implicit from behavior)
- **messages** — raw conversation messages with session_id, timestamp, speaker, content
- **sessions** — session metadata, hot/warm/cold status
- **summaries** — compacted node content, level, source_message_ids
- **context** — the current bootstrap context file

### Session Classification
- **Hot** — recent sessions (last 24h), full messages retained
- **Warm** — medium-term (1-7 days), first compaction level
- **Cold** — old sessions (>7 days), deeply compacted

### Compaction Model
- Default: `qwen2.5:32b-instruct` (runs locally via Ollama)
- Configurable via `MNEMO_COMPACTION_MODEL`
- Falls back gracefully if model unavailable

---

## OpenClaw Integration

### MCP Tools
Mnemo Cortex registers as an MCP server with tools:
- `mnemo_recall` — search memories
- `mnemo_status` — check memory stats
- `mnemo_health` — health monitoring
- `mnemo_compact` — trigger manual compaction

### Auto-Capture
```bash
mnemo-cortex watch --backfill
```
Watches OpenClaw session files and auto-ingests. `--backfill` processes existing sessions.

### Configuration
```json
{
  "mcpServers": {
    "mnemo-cortex": {
      "command": "mnemo-cortex",
      "args": ["mcp"]
    }
  }
}
```
One config line to add memory to any OpenClaw instance.

---

## Key Features

### Zero Agent Modification
Mem0 and similar systems require code changes to the agent. Mnemo is purely external:
- Watches session files (JSONL)
- No agent hooks needed
- Works with any agent that writes session logs

### Session-Based Architecture
Everything is organized by session. Query: "what happened in session X?" or "what's the agent's current context across all sessions?"

### 80% Token Compression
Rolling compaction reduces token count by ~80% while preserving all named entities. Key claim: "zero information loss on named entities" — the LLM is instructed to preserve all names, dates, and specific identifiers.

### Health Monitoring
Cron-able health checks:
```bash
0 */6 * * * mnemo-cortex health --quiet || your-alert-command
```

---

## Key Insights for AthenaMem

### What to steal:
1. **Sidecar pattern** — Memory outside the agent runtime. Decoupling is a feature.
2. **Session file watcher** — We can implement the same pattern for OpenClaw sessions. `~/.openclaw/sessions/*.jsonl`.
3. **DAG compaction with source tracing** — Every summary knows its source. Agent can always expand.
4. **Health monitoring** — Built-in health checks are the right pattern. Make it easy to verify memory is working.
5. **Hot/warm/cold session tiers** — We don't need this complexity yet, but the concept is good for future scaling.

### What to avoid:
1. **32b model for compaction** — Too large for most setups. Use smaller models (7b or embedding-based) for compaction.
2. **mnemo-specific session format** — We're watching OpenClaw's session format, not a custom one.

### Surprising details:
- The "ClaudePilot" AI-guided installation feature is interesting — natural language setup.
- OpenClaw MCP integration is already documented — we could use the same integration path.
- They note that Claude Desktop integration was broken by Anthropic's v2.1.87 session storage change — this is a real risk for session watcher patterns.

### Integration with AthenaMem:
- Sidecar watcher: implement as a separate daemon process, not blocking the main agent
- Watch OpenClaw session files at `~/.openclaw/sessions/`
- The `MNEMO-CONTEXT.md` bootstrap file pattern maps directly to our `SESSION-STATE.md`
- Health monitoring: add a similar `athenamem health` CLI command
- DAG compaction: already implementing in `compaction.ts`, but add session-based tiering (hot/warm/cold)

---

## What's Missing (Opportunities)

Mnemo Cortex has good session capture and compaction, but:
- No explicit contradiction detection (not mentioned in docs)
- No palace hierarchy — flat session-based storage
- No cross-wing or cross-agent shared memory
- Limited to text messages — doesn't capture file changes or tool results explicitly

These gaps are exactly where AthenaMem's palace architecture and KG layer add value.