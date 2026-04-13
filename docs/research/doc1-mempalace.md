# Research: MemPalace — Palace Architecture & Benchmark Winner

**Source:** https://github.com/MemPalace/mempalace  
**Stars:** 42,318 | **License:** MIT | **Language:** Python  
**Benchmark:** 96.6% on LongMemEval R@5 (500 questions, 0 API calls — raw verbatim mode)  
**Status:** Active development (2 core maintainers + 30 contributors)

---

## Core Innovation

MemPalace won on a counterintuitive insight: **don't summarize, store verbatim**. Most memory systems use LLM extraction to identify "important" facts — this is lossy and misses context. MemPalace stores everything raw, then relies on semantic search to find relevant content. The result: 96.6% R@5 vs alternatives scoring 60-80%.

The palace metaphor (ancient Greek orators) provides the organizational structure:
- **Wings** = people and projects (top-level)
- **Halls** = types of memory (decisions, preferences, milestones, problems, emotional context)
- **Rooms** = specific ideas within a hall
- **Closets** = summaries pointing to drawers
- **Drawers** = actual verbatim content

---

## Data Structures

### Storage (ChromaDB)
- Raw conversation exchanges stored without summarization
- Each drawer = one file or one message pair
- Closets = summaries that point back to drawer IDs
- No LLM call during storage — fast and deterministic

### Retrieval
- Semantic embedding via ChromaDB (e5-small or similar lightweight model)
- Wing + room metadata filtering (standard ChromaDB feature, gives +34% boost over unfiltered)
- Raw mode: no summarization or transformation at retrieval time

### AAAK (experimental dialect)
- **Purpose**: Compress repeated entities at scale for LLM context loading
- **How**: Abbreviate known entities using codes, truncate sentences
- **Status**: Currently regresses vs raw mode (84.2% vs 96.6% on benchmark)
- **Design flaw discovered by community**: Original README claimed AAAK saved tokens — actual tokenizer count shows it uses *more* tokens than the English original at small scales
- **Correct use case**: Repeated entities across thousands of memories, not small examples
- **Important**: AAAK is a separate compression layer, NOT the default storage mode

### fact_checker.py
- Standalone utility for contradiction detection
- **Not yet wired into main KG operations** (maintainers acknowledged this as a gap to fix)
- Pattern-based entity + predicate extraction

---

## Architecture Details

```
Session → Mine (classify into halls) → ChromaDB (verbatim storage)
                                        ↓
                                  Semantic search
                                        ↓
                              Results (verbatim → LLM → response)
```

### Mining Modes
1. **projects** — code, docs, any project files
2. **convos** — conversation exports (Claude, ChatGPT, Slack)
3. **general** — auto-classifies into decisions, preferences, milestones, problems, emotional context

### MCP Tools (19)
MemPalace exposes 19 MCP tools covering: add_conversation, add_file, search, list_halls, get_context, wake_up, and more.

---

## Key Insights for AthenaMem

### What to steal:
1. **Verbatim storage as default** — Don't summarize on write. Make it findable instead.
2. **Palace hierarchy** — Wings → Rooms → Closets → Drawers is a proven organizational metaphor
3. **Hall types** — The 5 hall types (facts, events, discoveries, preferences, advice) are a good starting taxonomy
4. **Raw mode benchmark result** — 96.6% vs alternatives. The message: search quality > summarization
5. **Tunnel concept** — Rooms that bridge multiple wings (shared topics)
6. **Haiku reranking** — Light model reranking on initial results boosts final accuracy

### What to avoid:
1. **AAAK overclaims** — The "30x lossless compression" and "+34% palace boost" claims were both misleading. Be conservative in benchmarks.
2. **fact_checker isolation** — Don't let contradiction detection be a separate utility. Wire it into the core KG flow.

### Surprising details:
- The benchmark is on 500 self-generated questions, not a public dataset. LongMemEval is the real benchmark.
- Milla & Ben published an unusually honest self-correction README within 48hrs of launch (acknowledging 4 specific errors). This suggests the project is well-led.
- No cloud/API calls in the benchmark pipeline — fully local.

### Integration with AthenaMem:
- Palace structure: directly adopt (wings/rooms/closets/drawers)
- FTS5 for search (instead of ChromaDB) — we already have this in qmd
- AAAK: adopt the dialect format, but note it's experimental and currently underperforms raw verbatim
- The wake-up command pattern: generate condensed context file for agent bootstrap

---

## Benchmark Comparison (from README)

| System | R@5 Score | Notes |
|--------|-----------|-------|
| **MemPalace raw** | **96.6%** | 500 questions, $0 API cost |
| Mem0 | ~60-70% | Self-reported |
| Hindsight | ~85% | (Note: Hindsight's own benchmark says differently) |
| Claude Conv retrievers | 65-80% | Various approaches |
| Naive context | 50% | Baseline |

*Note: These numbers are from MemPalace's own benchmark. Independent reproduction confirmed on M2 Ultra.*