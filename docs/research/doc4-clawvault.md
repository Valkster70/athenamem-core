# Research: ClawVault — Structured Memory with 8 Primitives

**Source:** https://github.com/Versatly/clawvault  
**Stars:** 641 | **License:** MIT | **Language:** TypeScript (83%)  
**Status:** Deprecated for new OpenClaw deployments — now maintained for migration reference only

> **Important context:** ClawVault is deprecated because OpenClaw now ships first-party memory with ClawVault's core ideas built in. This is actually a validation of the approach, not an indictment.

---

## Core Innovation

ClawVault was the first system to prove that **markdown-native structured memory** could work for AI agents. Instead of opaque databases or cloud services, ClawVault stores everything in markdown files organized in a structured directory hierarchy. This means:
- Human-readable at all times
- Git-friendly (diff and version control work naturally)
- Obsidian-compatible (browse memory like notes)
- No vendor lock-in

The 8 Primitives framework was their key organizing principle — mapping all memory operations to 8 fundamental types.

---

## The 8 Primitives

| Primitive | Purpose | ClawVault Implementation |
|-----------|---------|--------------------------|
| **Goals** | What the agent is trying to achieve | `tasks/`, `projects/`, `--working-on` flags |
| **Agents** | Identity and ownership tracking | `--owner` metadata, agent handoffs |
| **State Space** | Current context and environment | `checkpoint`, `recover`, session state |
| **Feedback** | Learning from outcomes | `lessons/`, `observations/`, reflection engine |
| **Capital** | Resources and constraints | Token budgets, context profiles, priority scoring |
| **Institution** | Rules and patterns | `decisions/`, `preferences/`, injection rules |
| **Synthesis** | Combining information | Graph traversal, context blending, semantic search |
| **Recursion** | Self-improvement loops | `reflect`, weekly promotion, archival |

These primitives map directly to CLI commands and vault structure, creating a coherent system for agent memory.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         ClawVault                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Agent ──▶ Session Watcher ──▶ Observer/Compressor ──▶ Router│
│                                                              │
│                    Markdown Vault                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐        │
│  │decisions/│ │ lessons/  │ │ people/   │ │projects│        │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐        │
│  │ tasks/   │ │ backlog/  │ │handoffs/ │ │ inbox/ │        │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘        │
│                                                              │
│  Internal State: graph-index.json, last-checkpoint.json      │
│                                                              │
│  Operations: wake | sleep | checkpoint | recover | reflect   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow
```
Session → Observe → Score → Route → Store → Reflect → Promote
```

### Key Operations
- **wake** — Load context from vault into agent
- **sleep** — Save current state to vault
- **checkpoint** — Save state without shutting down
- **recover** — Restore from checkpoint after crash
- **reflect** — Run weekly review and promotion of memories

---

## Storage Structure

```
~/.clawvault/
├── decisions/       # Decision records
│   └── YYYY-MM-DD--context-summary.md
├── lessons/        # Learned lessons
├── people/         # Person entities
├── projects/       # Project entities
├── tasks/          # Active tasks
├── backlog/        # Deferred tasks
├── handoffs/       # Agent-to-agent handoffs
├── inbox/          # Pending items
├── .clawvault/     # Internal state
│   ├── graph-index.json    # Wiki-link graph
│   ├── last-checkpoint.json
│   └── config
```

---

## Fact Extraction

ClawVault extracts structured facts at write time:
- When a decision is recorded, entities and predicates are parsed
- Conflicts are detected during write (not at read time)
- Graph is built from wiki-links (`[[entity]]` syntax)

### Wiki-Link Graph
```markdown
# Decision: Database choice

Team decided to use [[PostgreSQL]] over [[MongoDB]] for the new API.

Related: [[Project Alpha]], [[Alice]], [[Bob]]
```

The `[[bracket]]` syntax builds a graph that can be traversed for context enrichment.

---

## Key Features

### Markdown-Native
Every memory is a `.md` file. Open it in Obsidian. Diff it in git. Edit it manually. No lock-in.

### Checkpoint/Recover
```bash
clawvault checkpoint
clawvault recover  # After crash
```
Checkpoint saves state atomically. Recover restores to last known good state.

### Graph Traversal
The graph index (`graph-index.json`) tracks all wiki-links. Can query: "what entities are connected to Project Alpha?" or "who has worked on this topic?"

### Wiki-Link Aware Search
Combines keyword search with graph traversal:
1. Find files matching keyword
2. Expand to files linked from those files
3. Rank by connection depth

---

## Deprecation Note

The ClawVault README says: *"OpenClaw now ships the official, maintained memory path directly, including builtin memory and QMD-backed local retrieval."*

This is important context for AthenaMem: the ideas ClawVault pioneered (structured markdown storage, wiki-links, checkpoint/recover) are now first-party in OpenClaw. We're not competing with ClawVault — we're building on its legacy.

But ClawVault had no KG, no contradiction detection, and limited search (no BM25+vector hybrid). That's where AthenaMem adds value.

---

## Key Insights for AthenaMem

### What to steal:
1. **8 Primitives taxonomy** — The Goals/Agents/State/Feedback/Capital/Institution/Synthesis/Recursion framework is a useful organizing principle. We can map our Hall types to these primitives.
2. **Wiki-link graph** — `[[entity]]` syntax for building connections is simple and effective. Could implement in KG layer.
3. **Checkpoint/recover** — Atomic state saves are essential. WAL already does this, but the CLI UX (checkpoint/recover commands) is good.
4. **Directory structure** — `decisions/`, `lessons/`, `people/`, `projects/` — these map well to our palace halls.
5. **Obsidian compatibility** — Making memory human-readable and browsable in Obsidian is a great feature. Our markdown drawer files support this.

### What to avoid:
1. **Flat storage** — ClawVault has no room/closet hierarchy. Everything is a flat directory. This limits scalability.
2. **No contradiction detection wired in** — The deprecation note doesn't mention this, but it was a known gap.
3. **Limited search** — No BM25+vector hybrid. qmd handles this better.

### Surprising details:
- ClawVault was TypeScript from the start — early choice for a JS-native tool.
- The 466 passing tests gives high confidence in the core logic.
- Obsidian plugin shows they thought about human-facing memory browsing seriously.
- They're pointing users to OpenClaw native memory now — this is competitive pressure but also validation that the approach works.

### Integration with AthenaMem:
- ClawVault deprecation means we can offer migration from ClawVault structured storage
- The `decisions/`, `lessons/`, `people/`, `projects/` directories map directly to palace halls
- Wiki-link pattern: implement `[[entity]]` parsing in KG entity extraction
- Checkpoint/recover: our WAL already implements this, but the CLI UX is simpler
- The "institution" primitive (rules and patterns) maps to our `advice` hall

---

## Migration Path from ClawVault

For users migrating from ClawVault to AthenaMem:
1. Parse existing vault directories (`decisions/`, `lessons/`, etc.)
2. For each file, extract entities from wiki-links
3. Create palace structure: wing = user, rooms = topic areas
4. Import drawers with hall classification
5. Build KG from wiki-link graph

This gives AthenaMem instant compatibility with existing ClawVault users.