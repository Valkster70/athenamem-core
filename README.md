# AthenaMem

![AthenaMem](athenamem-main.png)

> **"The memory that learns."**

A biomimetic memory stack for AI agents — built on the principle that memory isn't storage, it's a living system that organizes, prioritizes, connects, and improves itself over time.

AthenaMem draws from the best ideas in the memory systems landscape — Palace architecture, WAL durability, DAG compaction, multi-strategy retrieval, contradiction detection — and synthesizes them into something that feels less like a database and more like an actual brain.

**Built as a personal project** to create the memory system that doesn't exist yet.

---

## Why AthenaMem?

Most AI memory systems are either:
- **Too shallow**: Vector search + basic storage, no structure, no hierarchy
- **Too opaque**: Black-box retrieval, can't trace summaries back to sources
- **Too fragmented**: No unified approach across hot/warm/cold storage tiers

AthenaMem tries to be different. It has opinions:
- **Don't summarize, make it findable** — verbatim storage is a feature, not a bug
- **Write before you respond** — WAL enforcement means no context loss
- **Contradictions are first-class** — if you change your mind, the system notices
- **Every fact traces back to its source** — DAG-compacted summaries always link to originals

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      AthenaMem Palace                         │
├──────────────────────────────────────────────────────────────┤
│ L0 — Identity      Always loaded. Who am I? Who do I serve?   │
│ L1 — Critical      Always loaded. Team, projects, preferences.│
│ L2 — Recent        On demand per topic. Active sessions.       │
│ L3 — Deep Search   Explicit query across all systems.          │
│ L4 — Archive       Curated cold storage. Rarely touched.       │
└──────────────────────────────────────────────────────────────┘
```

### Palace Structure

```
WING (agent/user/project)
  └── ROOM (topic)
        └── CLOSET (summary → points to drawers)
              └── DRAWER (verbatim record)
                    └── HALL (facts | events | discoveries | preferences | advice)
```

### WAL Enforcement

```
Agent receives message
  1. Write context to WAL (durable)
  2. THEN generate response
  3. After response, optionally update KG + reflections
```

---

## Key Ideas from Reference Systems

| System | Best Idea | AthenaMem Implementation |
|--------|-----------|--------------------------|
| **MemPalace** | Palace metaphor, verbatim storage, tunnels | Full palace structure (wings/rooms/closets/drawers) |
| **Hindsight** | Reflect/retain/recall cycle, biomimetic model | Compaction engine + contradiction detection |
| **Elite Longterm Memory** | WAL protocol, write-before-respond | WAL enforcement in core |
| **Mnemo Cortex** | DAG compaction, source tracing | DAG nodes with full source chains |
| **ClawVault** | 8 memory primitives, structured types | Hall types + KG entity schema |
| **MindClaw** | Per-agent LoRA specialization | Specialist wings + diaries |
| **Mem0** | Importance scoring, self-improvement | Memory importance + access tracking |
| **qmd** | Hybrid BM25+vector search | Cross-system query orchestrator |

---

## Status

**Under active development.** The core modules are scaffolded and the architecture is defined. See `SPEC.md` for the full roadmap.

Current status:
- ✅ Core KG (SQLite with temporal validity)
- ✅ WAL enforcement
- ✅ Contradiction detection engine
- ✅ Palace structure (wings/rooms/closets/drawers)
- ✅ Compaction engine (DAG-based)
- ✅ Search orchestrator (RRF fusion)
- ✅ CLI
- ✅ MCP server + OpenClaw plugin
- ⏳ Specialist agents + diaries

---

## Status

**Under active development.** The core modules are scaffolded and the architecture is defined. See `SPEC.md` for the full roadmap.

Current status:
- ✅ Core KG (SQLite with temporal validity)
- ✅ WAL enforcement
- ✅ Contradiction detection engine
- ✅ Palace structure (wings/rooms/closets/drawers)
- ✅ Compaction engine (DAG-based)
- ✅ Search orchestrator (RRF fusion)
- ✅ CLI


---

## Quick Start

```bash
# Install
npm install -g athenamem

# Initialize
athenamem init

# Create a wing (one per person/agent/project)
athenamem wings add chris --desc "Chris's memory wing"
athenamem wings add athena --desc "Athena AI's memory wing"

# Store a memory
athenamem remember chris memory-stack \
  --content "Using SQLite with WAL for the knowledge graph" \
  --hall discoveries

# Search across all systems
athenamem recall "why did we switch database"

# Quick search (qmd + KG only)
athenamem search "database decision"
```

---

## Documentation

- [SPEC.md](SPEC.md) — Full architecture specification
- [docs/architecture.md](docs/architecture/) — Detailed design docs
- [docs/research/](docs/research/) — Research on reference systems

---

## Built With

- **TypeScript** + **Node.js** (Python migration path for PyO3 later)
- **SQLite** with `better-sqlite3` (WAL mode, FTS5)
- **Reciprocal Rank Fusion** for cross-system query fusion

---

## Contributing

This is a passion project to build the memory system that doesn't exist yet.

Ideas and feedback welcome.
