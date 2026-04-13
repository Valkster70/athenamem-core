# Research: Hindsight — Biomimetic Memory That Actually Learns

**Source:** https://github.com/vectorize-io/hindsight  
**Stars:** 8,974 | **License:** MIT | **Languages:** Python (71%), TypeScript (16%), Rust (3.5%)  
**Website:** https://hindsight.vectorize.io  
**Status:** Production at Fortune 500 companies

---

## Core Innovation

**"Agents that learn, not just remember."** Hindsight's key insight is that most memory systems focus on recall — remembering what happened. Hindsight focuses on **learning** — extracting patterns, surfacing contradictions, and improving over time.

The biomimetic model draws from human memory:
- **Working memory** → current session context
- **Episodic memory** → specific conversations and events
- **Semantic memory** → distilled facts and knowledge
- **Procedural memory** → patterns for how the agent operates

This maps to Hindsight's 3-cycle architecture.

---

## Architecture: Reflect / Retain / Recall

### Phase 1: Reflect
After each conversation turn, Hindsight analyzes what happened and extracts:
- **Entities mentioned** (people, projects, topics)
- **Assertions made** (decisions, preferences, facts)
- **Emotional tone** (positive/negative/neutral)
- **Goal progression** (did we make progress on stated goals?)

### Phase 2: Retain
Extracted information is stored with:
- **Importance scoring** — not all facts are equal
- **Temporal validity** — when is this fact true? (and when did it stop being true?)
- **Source tracing** — which conversation this came from
- **Contradiction detection** — does this conflict with something previously stored?

### Phase 3: Recall
When the agent needs memory, Hindsight retrieves with:
- **Temporal awareness** — "what was true 3 months ago?"
- **Relevance scoring** — based on current context
- **Importance weighting** — important facts rank higher
- **Reranking** — LLM reranks initial results for quality

---

## Data Model

### Storage: PostgreSQL + pgvector
- Hindsight uses PostgreSQL with pgvector for hybrid storage
- Can also use SQLite (via different driver)
- Schema supports: conversations, facts, entities, relationships, temporal windows

### Fact Structure
```
fact {
  id, content, source_conversation_id,
  extracted_at, valid_from, valid_to,
  importance, confidence,
  contradicted_by, contradiction_resolved
}
```

### Entity Structure
```
entity {
  id, name, type (person|project|topic|preference|decision),
  first_mentioned, last_updated,
  current_value, historical_values[]
}
```

---

## Key Features

### 1. LLM Wrapper Integration
Two lines of code to add memory to an existing agent:
```python
from vectorize.hindsight import HindsightWrapper
agent = HindsightWrapper(your_existing_agent)
# Memories stored and retrieved automatically
```

### 2. Importance Scoring
Hindsight learns which facts matter by tracking:
- How often a fact is retrieved
- Whether retrieval led to successful responses
- User corrections or confirmations
- Time since last mention vs. relevance

### 3. Temporal Validity
Every fact has a validity window. When an entity changes state:
```python
# Old fact gets valid_to = now
entity.update({valid_to: datetime.now()})
# New fact gets valid_from = now
entity.add({valid_from: datetime.now()})
```
Query: "What did we know about X at time T?"

### 4. Contradiction Detection
- When a new fact conflicts with an existing one, both are flagged
- Agent is notified: "You previously said X, now saying Y — which is correct?"
- Human or agent can resolve the contradiction

### 5. Health Monitoring Dashboard
- Web UI at port 9999 showing memory stats
- API at port 8888 for programmatic access
- Metrics: total facts, entities, retrieval accuracy, contradiction count

---

## Docker Deployment

```bash
export OPENAI_API_KEY=sk-xxx
docker run --rm -it -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  ghcr.io/vectorize-io/hindsight:latest
```

Supports: OpenAI, Anthropic, Gemini, Groq, Ollama, LM Studio, MiniMax

---

## Key Insights for AthenaMem

### What to steal:
1. **Importance scoring** — Not all facts are equal. Track importance and let it influence retrieval weight.
2. **Temporal validity windows** — Already implementing in KG, but Hindsight's specific API pattern is good reference.
3. **Contradiction flagging with human resolution** — Store the conflict, let the agent/user decide.
4. **Biomimetic 4-layer model** — working/episodic/semantic/procedural is a useful framing for the L0-L4 layer system.
5. **LLM wrapper pattern** — Two-line integration is the right UX target. Make AthenaMem trivially integrable.

### What to avoid:
1. **PostgreSQL dependency** — We're using SQLite. Hindsight's schema maps well to SQLite though.
2. **Cloud-first branding** — Hindsight Cloud exists but local-only is fully supported. We should emphasize local.

### Surprising details:
- Hindsight is used in production at Fortune 500 companies — this is battle-tested.
- Independent reproduction of their benchmark at Virginia Tech and Washington Post — credibility加分.
- They use a mix of Python (core), TypeScript (client SDK), and Rust (performance-critical paths) — similar stack to what we're planning.
- Health monitoring API (`/health` endpoint returning JSON) is a good pattern for the CLI.

### Integration with AthenaMem:
- Hindsight URL already in our orchestrator config (`http://127.0.0.1:8888`)
- Can call Hindsight's recall API directly for cross-system fusion
- The importance scoring algorithm: track access_count + user feedback → adjust importance score
- Temporal validity: adopt Hindsight's valid_from/valid_to pattern in our KG

---

## Benchmark Notes

Hindsight claims state-of-the-art on LongMemEval, but their numbers differ from MemPalace's claims. Both can't be right at the same time on the same benchmark. Likely explanation: different test configurations (e.g., different subsets of the 500 questions, different retrieval parameters).

**What this means for AthenaMem:** Be conservative with benchmark claims. Use independent benchmarks or clearly document your test setup. Don't inflate numbers.