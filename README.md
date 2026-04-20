# AthenaMem

![AthenaMem](athenamem-splash.png)

> **The memory that learns.**

AthenaMem is a biomimetic memory system for AI agents. It does more than retrieve chunks, it tracks facts, confidence, access patterns, contradictions, and change over time.

**Current release:** `v0.3.2`  
**Status:** stable beta / early public release

---

## Why AthenaMem exists

Most memory systems for agents are good at storing text, but weak at managing knowledge.

AthenaMem is built for agents that need memory with structure and behavior:

- **Knowledge graph memory** instead of just embeddings
- **Confidence-weighted facts** that can strengthen or decay
- **Access tracking** so memory changes based on actual use
- **Dormancy** for stale knowledge that should fade out gracefully
- **Contradiction surfacing** when new facts collide with old ones
- **Durable WAL-first writes** so context is stored before replies are generated
- **Cross-system recall fusion** across AthenaMem, qmd, ClawVault, Hindsight, and Mnemo

---

## Standout features

### Confidence-weighted knowledge graph
Entities and relations carry confidence, access count, last accessed time, status, and area.

This means AthenaMem can represent not just *what is known*, but *how strongly it is believed*.

### Memory that changes over time
AthenaMem supports:

- **confidence gain** from repeated use or confirmation
- **confidence decay** for zero-access stale knowledge
- **dormant entities** when confidence reaches zero
- **reactivation** when dormant knowledge becomes relevant again

### Inline contradiction and conflict surfacing
When new high-confidence facts conflict with existing ones, AthenaMem can surface that conflict immediately instead of silently storing inconsistent state.

### WAL durability
AthenaMem uses write-ahead logging so memory is written before the agent responds. That makes it more resilient to crashes, interruptions, and context loss.

### Cross-system recall
AthenaMem doesn't pretend it is the only memory system. It can search and fuse results from:

- AthenaMem KG
- qmd
- ClawVault
- Hindsight
- Mnemo Cortex

---

## What makes it different

| System | Typical behavior | AthenaMem difference |
|--------|------------------|----------------------|
| Vector memory | Retrieves similar chunks | Tracks structured facts and relationships |
| Notes / journals | Stores raw text | Adds confidence, decay, contradictions, and recall behavior |
| Naive RAG memory | Finds text that looks relevant | Knows entities, relations, source traces, and conflict state |
| Simple KV memory | Saves state | Evolves memory based on use and staleness |

AthenaMem is closer to a **living memory layer** than a document index.

---

## Architecture

```text
AthenaMem Palace
├── L0 — Identity      Always loaded
├── L1 — Critical      Always loaded
├── L2 — Recent        On-demand per topic
├── L3 — Deep Search   Explicit multi-system recall
└── L4 — Archive       Curated cold storage
```

### Palace structure

```text
WING (agent/user/project)
  └── ROOM (topic)
        └── CLOSET (summary → points to drawers)
              └── DRAWER (verbatim record)
                    └── HALL (facts | events | discoveries | preferences | advice)
```

### Write-before-respond flow

```text
Agent receives message
  1. Write context to WAL
  2. Generate response
  3. Update KG / reflections / compaction
```

---

## Current release highlights (`v0.3.2`)

- confidence-weighted KG for entities and relations
- access tracking (`access_count`, `last_accessed`)
- decay CLI and scheduled decay support
- dormant entity handling
- inline `kg_add` conflict surfacing
- plugin/runtime wiring validated on Hermes
- one-command Hermes deploy flow

---

## Quick start

```bash
# Clone
git clone <your-repo-url>
cd athenamem-core

# Install dependencies
npm install

# Build
npm run build

# Run CLI
athenamem init

# Store a fact
athenamem remember main decisions facts \
  --content "AthenaMem uses SQLite with WAL mode for the knowledge graph"

# Search
athenamem recall "why did we choose SQLite"

# Health check
athenamem doctor
```

If you haven't installed the CLI globally, use:

```bash
node ./dist/cli/index.js <command>
```

---

## Deployment

### Current Athena / Hermes workflow

From the Athena repo checkout:

```bash
./scripts/deploy-hermes.sh
```

That will:

- sync the repo into the live Hermes plugin directory
- build on Hermes
- run tests on Hermes
- restart the Hermes gateway

---

## Example operational capabilities

AthenaMem can:

- add structured facts to a knowledge graph
- detect when new facts contradict existing beliefs
- decay stale zero-access memory over time
- keep rarely used knowledge dormant instead of pretending everything stays equally true forever
- trace recall back to original sources
- fuse recall across multiple memory backends

---

## End-user maintenance

```bash
# Check system health
athenamem doctor

# Find likely memory coverage gaps
athenamem gap-scan ./memory

# Verify a fact is actually findable
athenamem verify "SQLite with WAL"

# Backfill a source file into live memory
athenamem backfill-file ./notes/today.md main backfill discoveries

# Rebuild the search index
athenamem rebuild-fts
```

---

## Built with

- **TypeScript** + **Node.js** (>=22)
- **SQLite** with `better-sqlite3`
- **WAL mode** and FTS-backed search
- **Knowledge graph memory** with confidence + decay
- **Reciprocal Rank Fusion** for multi-system recall
- **OpenClaw plugin integration**

---

## Documentation

- [SPEC.md](SPEC.md) — architecture and behavior
- [docs/](docs/) — supporting docs and research

---

## License

[MIT](LICENSE)

---

*AthenaMem, because memory should do more than retrieve text.*
