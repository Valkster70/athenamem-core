# AthenaMem Core — Architecture Specification

> **Version:** 0.3.2  
> **Status:** Core modules complete, runtime verified  

---

## Overview

AthenaMem Core is a biomimetic memory stack for AI agents that treats memory as a living system rather than passive storage. It combines:

- **Structure:** Palace architecture (wings → rooms → drawers)
- **Durability:** WAL enforcement for crash recovery
- **Knowledge:** Temporal knowledge graph with contradiction detection
- **Retrieval:** Multi-source fusion (BM25 + vector + KG)
- **Compression:** DAG-based compaction with source tracing

---

## Architecture Layers

### L0 — Identity
Always resident. Agent self-knowledge: who am I, who do I serve, core directives.

### L1 — Critical
Always resident. Team members, active projects, current preferences.

### L2 — Recent
On-demand loaded per topic. Active sessions, recent decisions.

### L3 — Deep Search
Explicit query across all memory systems (KG, qmd, ClawVault, Hindsight, Mnemo).

### L4 — Archive
Curated cold storage. Rarely accessed but indexed.

---

## Core Components

### 1. Knowledge Graph (`src/core/kg.ts`)

**Storage:** SQLite with WAL mode, FTS5 for text search

**Entities:**
| Type | Description |
|------|-------------|
| `agent` | AI agents (athena, etc.) |
| `person` | Human users |
| `project` | Work projects |
| `concept` | Abstract ideas |
| `memory` | Verbatim storage units |

**Temporal Validity:**
- `valid_from`: Unix ms when entity became true
- `valid_until`: Unix ms when entity ceased to be true (NULL = still valid)
- All queries support `as_of` parameter for time-travel

**Contradiction Detection:**
- Extracts facts from text using pattern matching
- Compares against active entities in KG
- Flags conflicts for resolution

### 2. Structure (`src/core/structure.ts`)

Palace hierarchy for organizing memory:

```
WING (module)
  └── ROOM (section)
        └── CLOSET (summary → links to drawers)
              └── DRAWER (entry)
                    └── HALL (category: facts | events | discoveries | preferences | advice)
```

**Bridges:** Sections that connect multiple wings (cross-cutting topics).

### 3. WAL Manager (`src/core/wal.ts`)

Write-Ahead Log enforcement:

```
Agent receives message
  1. BEGIN — write context state to WAL
  2. RESPOND — generate agent response
  3. COMMIT — mark WAL entry committed
  4. OPTIONAL — update KG, run compaction
```

**Crash Recovery:** On agent boot, scan for uncommitted WAL entries and replay.

### 4. Compaction Engine (`src/core/compaction.ts`)

DAG-based memory compression:

- **Level 0:** Verbatim memories (raw text)
- **Level 1:** Summaries with source links
- **Level 2:** Higher-order abstractions
- **Level N:** Archive-ready distillations

Every compacted node maintains full provenance chain back to original memories.

### 5. Search Orchestrator (`src/search/orchestrator.ts`)

Reciprocal Rank Fusion (RRF) across sources:

| Source | Query Type | Use Case |
|--------|------------|----------|
| KG | Structured | Entity relationships |
| qmd | BM25 + vector | Document search |
| ClawVault | File-based | Daily notes |
| Hindsight | API | Long-term context |
| Mnemo | API | Session recovery |

**RRF Formula:** `score = Σ 1/(k + rank)` where k=60

### 6. Contradiction Detector (`src/core/contradiction.ts`)

Fact extraction → KG comparison → conflict flagging:

- Extracts `FACT | subject | predicate | object | confidence` from text
- Queries KG for matching entities/relations
- Reports contradictions with confidence deltas
- Supports resolution strategies: keep_new, keep_old, merge, invalidate_old

---

## MCP Tools (22)

| Tool | Purpose |
|------|---------|
| `athenamem_core_status` | System overview |
| `athenamem_core_list_modules` | List all wings |
| `athenamem_core_list_sections` | List rooms in a wing |
| `athenamem_core_search` | Hybrid search |
| `athenamem_core_quick_search` | Quick search (qmd + KG only) |
| `athenamem_core_get_aaak_spec` | AAAK dialect reference |
| `athenamem_core_add_entry` | Store verbatim content |
| `athenamem_core_delete_entry` | Remove entry (soft) |
| `athenamem_core_kg_query` | Query entities/relations |
| `athenamem_core_kg_add` | Add fact to KG |
| `athenamem_core_kg_invalidate` | Mark entity ended |
| `athenamem_core_kg_timeline` | Chronological entity history |
| `athenamem_core_check_facts` | Detect contradictions |
| `athenamem_core_resolve_conflict` | Resolve flagged conflicts |
| `athenamem_core_diary_write` | Agent diary entry |
| `athenamem_core_diary_read` | Read diary entries |
| `athenamem_core_traverse` | Walk palace bridges |
| `athenamem_core_find_bridges` | Find cross-wing connections |
| `athenamem_core_recall` | Deep cross-system search |
| `athenamem_core_create_wing` | Create new wing |
| `athenamem_core_create_room` | Create new room |
| `athenamem_core_wal_flush` | Force WAL to disk |

---

## AAAK — Agent Acknowledgment Language

Structured format for memory operations:

```
MEMORY | module | section | category | importance | content
FACT | subject | predicate | object | confidence
DECISION | context | choice | reason | alternatives
LESSON | context | learning | implication
DIARY | agent | type | content
CONFLICT | memory_id | conflicts_with | resolution_status
```

---

## Data Flow

```
User Query
    ↓
Search Orchestrator (RRF)
    ├── KG (entities/relations)
    ├── qmd (BM25 + vector)
    ├── ClawVault (files)
    ├── Hindsight (API)
    └── Mnemo (API)
    ↓
Ranked Results
    ↓
Agent Response Generation
    ↓
WAL Checkpoint
    ↓
Optional: Contradiction Check → KG Update
```

---

## Configuration

```json
{
  "data_dir": "./athenamem/data",
  "structure_dir": "./athenamem/structure",
  "compact_on_flush": true,
  "contradiction_check": true,
  "auto_wal": true,
  "qmd_path": "~/.cache/qmd",
  "clawvault_path": "./memory",
  "hindsight_url": "http://127.0.0.1:8888",
  "mnemo_url": "http://127.0.0.1:50001"
}
```

---

## Testing Status

| Component | Status | Verified |
|-----------|--------|----------|
| KG operations | ✅ | 12 entities, 8 memories |
| Structure | ✅ | 4 wings, 5 sections |
| Search | ✅ | RRF fusion working |
| Tools | ✅ | 20/20 registered |
| WAL | ⏳ | Implementation complete |
| Compaction | ⏳ | Implementation complete |
| Contradiction | ⏳ | Implementation complete |

---

## Future Work

- Specialist agents with dedicated diaries
- Multi-agent memory bridges
- External memory adapters (Notion, Obsidian)
- Visual palace navigator

---

## References

- MemPalace: Palace architecture, verbatim storage
- Hindsight: Reflect/retain/recall cycle
- Mnemo Cortex: DAG compaction, source tracing
- ClawVault: Structured memory primitives
- Reciprocal Rank Fusion: Multi-source ranking
