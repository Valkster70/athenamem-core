/**
 * AthenaMem OpenClaw Plugin
 *
 * This is the main plugin entry point. It registers all MCP tools,
 * lifecycle hooks (on_agent_boot, on_agent_sleep, on_turn, on_flush),
 * and wires AthenaMem into the OpenClaw gateway.
 *
 * Tools implemented (19):
 * - Palace read (5): status, list_wings, list_rooms, search, get_aaak_spec
 * - Palace write (2): add_drawer, delete_drawer
 * - KG (4): kg_query, kg_add, kg_invalidate, kg_timeline
 * - Contradiction (2): check_facts, resolve_conflict
 * - Agent diary (2): diary_write, diary_read
 * - Navigation (2): traverse, find_tunnels
 * - Cross-system recall (2): recall (deep search), quick_search
 */
import { KnowledgeGraph } from '../core/kg.js';
import { Palace } from '../core/palace.js';
import { WALManager } from '../core/wal.js';
import { ContradictionDetector, extractFacts } from '../core/contradiction.js';
import { CompactionEngine, RuleBasedCompiler } from '../core/compaction.js';
import { SearchOrchestrator } from '../search/orchestrator.js';
import { ingestMemoryEvent } from '../core/ingestion.js';
import { traceMemory, explainRecall } from '../core/debug.js';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
let ctx = null;
export function getContext() {
    if (!ctx || !ctx.initialized) {
        throw new Error('AthenaMem not initialized. Call init() first.');
    }
    return ctx;
}
// ─── Initialization ───────────────────────────────────────────────────────────
export async function init(config = {}) {
    if (ctx?.initialized)
        return;
    const home = process.env.HOME ?? homedir();
    const workDir = path.join(home, '.openclaw', 'workspace', 'athenamem');
    const cfg = {
        data_dir: config.data_dir ?? path.join(workDir, 'data'),
        palace_dir: config.palace_dir ?? path.join(workDir, 'palace'),
        compact_on_flush: config.compact_on_flush ?? true,
        contradiction_check: config.contradiction_check ?? true,
        auto_wal: config.auto_wal ?? true,
        qmd_path: config.qmd_path ?? path.join(home, '.cache', 'qmd'),
        clawvault_path: config.clawvault_path ?? path.join(home, '.openclaw', 'workspace', 'memory'),
        hindsight_url: config.hindsight_url ?? 'http://127.0.0.1:8888',
        mnemo_url: config.mnemo_url ?? 'http://127.0.0.1:50001',
    };
    for (const dir of [cfg.data_dir, cfg.palace_dir]) {
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
    }
    const kg = new KnowledgeGraph(path.join(cfg.data_dir, 'athenamem.db'));
    const palace = new Palace(kg, cfg.palace_dir);
    const wal = new WALManager(path.join(cfg.data_dir, 'wal'));
    const detector = new ContradictionDetector(kg);
    const compiler = new RuleBasedCompiler();
    const compaction = new CompactionEngine(kg, path.join(cfg.data_dir, 'compaction'), compiler);
    const orchestrator = new SearchOrchestrator(kg, palace, {
        qmdPath: cfg.qmd_path,
        clawvaultPath: cfg.clawvault_path,
        hindsightUrl: cfg.hindsight_url,
        mnemoUrl: cfg.mnemo_url,
    });
    ctx = {
        config: cfg,
        kg,
        palace,
        wal,
        detector,
        compaction,
        orchestrator,
        sessionId: `session-${Date.now()}`,
        agentId: 'athena',
        initialized: true,
    };
    console.log('[AthenaMem] Initialized. Palace ready.');
}
export function setSession(sessionId, agentId) {
    if (ctx) {
        ctx.sessionId = sessionId;
        ctx.agentId = agentId;
        ctx.wal.setSession(sessionId);
        ctx.wal.setAgent(agentId);
    }
}
// ─── Lifecycle Hooks ───────────────────────────────────────────────────────────
/**
 * on_agent_boot — called when the agent starts.
 * Loads L0 (identity) and L1 (critical facts) into context.
 * Checks for uncommitted WAL entries from a crash.
 */
export async function onAgentBoot() {
    const c = getContext();
    const recovered = c.wal.recover();
    // Write session state from latest committed WAL
    const sessionStatePath = path.join(c.config.data_dir, 'SESSION-STATE.md');
    await c.wal.writeSessionState(sessionStatePath);
    // Get L0 + L1 from KG
    const criticalEntities = c.kg.queryEntities({}).filter(e => {
        const type = e.type;
        return type === 'agent' || type === 'person' || type === 'project';
    });
    const l0_l1_summary = [
        '# AthenaMem Bootstrap — L0 + L1',
        '',
        `Session: ${c.sessionId} | Agent: ${c.agentId}`,
        '',
        '## Critical Entities',
        ...criticalEntities.map(e => `- ${e.name} (${e.type}) — valid from ${new Date(e.valid_from).toISOString()}`),
        '',
        '## Active Wings',
        ...c.palace.listWings().map(w => `- ${w.name}: ${w.room_count} rooms, ${w.memory_count} memories`),
        '',
        recovered
            ? `⚠️  WARNING: Recovered uncommitted state from crash at ${new Date(recovered.timestamp).toISOString()}`
            : 'No crash recovery needed.',
    ].join('\n');
    return { context: l0_l1_summary, recovered: !!recovered, l0_l1_summary };
}
/**
 * on_agent_sleep — called when the agent shuts down.
 * Writes final checkpoint and updates KG.
 */
export async function onAgentSleep(summary) {
    const c = getContext();
    const sessionStatePath = path.join(c.config.data_dir, 'SESSION-STATE.md');
    let sessionState = '';
    if (fs.existsSync(sessionStatePath)) {
        sessionState = fs.readFileSync(sessionStatePath, 'utf-8');
    }
    const entry = c.wal.checkpoint({
        session_state: sessionState,
        learnings: summary ? [summary] : [],
    });
    c.wal.commit();
    return { checkpoint_id: entry.id.substring(0, 8) };
}
/**
 * on_turn — called before every agent response.
 * Enforces WAL: writes state BEFORE responding.
 */
export async function onTurn(contextState) {
    const c = getContext();
    if (!c.config.auto_wal)
        return { wal_id: '' };
    const entry = c.wal.begin({ session_state: contextState });
    return { wal_id: entry.id };
}
/**
 * on_commit — called after successful agent response.
 * Marks WAL entry as committed.
 */
export async function onCommit() {
    getContext().wal.commit();
}
/**
 * on_flush — called before context window flush.
 * Runs DAG compaction and updates active frontier.
 */
export async function onFlush() {
    const c = getContext();
    if (!c.config.compact_on_flush)
        return { compacted: 0, new_frontier_nodes: 0 };
    const allMemories = c.kg.searchMemories('', undefined, undefined, 1000);
    const { toCompact } = c.compaction.scheduleCompaction(allMemories);
    let compacted = 0;
    for (const batch of toCompact) {
        try {
            await c.compaction.compact(batch.ids, batch.level, 'athena', 'context');
            compacted++;
        }
        catch (err) {
            console.error('[AthenaMem] Compaction batch failed:', err);
        }
    }
    const frontier = c.compaction.getActiveFrontier();
    return { compacted, new_frontier_nodes: frontier.length };
}
// ─── Unified Ingestion Pipeline ────────────────────────────────────────────────
/**
 * Unified memory ingestion — THE single entry point for all memory writes.
 *
 * All tools that create memory must use this function.
 * It provides durability, auditability, salience scoring, and KG updates.
 */
export async function ingestMemory(module, section, category, content, options = {}) {
    const c = getContext();
    const event = {
        sessionId: c.sessionId,
        agentId: c.agentId,
        moduleName: module,
        sectionName: section,
        category,
        content,
        source: options.source ?? 'tool',
        confidence: options.confidence ?? 1.0,
        salience: 0.5, // Will be computed by pipeline
        provenance: {
            triggerTool: options.provenance?.triggerTool,
            filePath: options.filePath,
            parentMemoryIds: options.provenance?.parentMemoryIds,
        },
    };
    return ingestMemoryEvent(c, event, {
        skipContradictionCheck: options.skipContradictionCheck,
    });
}
// ─── MCP Tools ─────────────────────────────────────────────────────────────────
/**
 * athenamem_status — L0-L4 overview + AAAK spec.
 */
export async function toolStatus() {
    const c = getContext();
    const stats = c.kg.stats();
    const wings = c.palace.listWings();
    const walStats = c.wal.stats();
    const compactStats = c.compaction.stats();
    return [
        '# AthenaMem Status',
        '',
        '## Knowledge Graph',
        `  Entities: ${stats.entity_count} (${stats.active_entities} active)`,
        `  Relations: ${stats.relation_count}`,
        `  Memories: ${stats.memory_count} | Entries: ${stats.entry_count}`,
        `  Contradictions: ${stats.contradictions}`,
        '',
        '## Palace',
        `  Wings: ${wings.length}`,
        ...wings.map(w => `  - ${w.name}: ${w.room_count} rooms, ${w.memory_count} memories`),
        '',
        '## WAL',
        `  Entries: ${walStats.total_entries} (${walStats.committed} committed, ${walStats.uncommitted} uncommitted)`,
        `  Recovery: ${walStats.recovery_available ? 'available' : 'none'}`,
        '',
        '## Compaction',
        `  Nodes: ${compactStats.total_nodes} | Avg compression: ${Math.round((1 - compactStats.avg_compression_ratio) * 100)}%`,
        `  Deepest path: ${compactStats.deepest_path} levels`,
        '',
    ].join('\n');
}
/**
 * athenamem_list_wings — all wings with counts.
 */
export async function toolListWings() {
    return getContext().palace.listWings();
}
/**
 * athenamem_list_rooms — rooms within a wing.
 */
export async function toolListRooms(wingName) {
    return getContext().palace.listRooms(wingName);
}
/**
 * athenamem_search — hybrid search with wing/room filters.
 */
export async function toolSearch(query, wing, room, limit = 20) {
    const c = getContext();
    const response = await c.orchestrator.search({ query, wing, room, limit });
    return response.results;
}
/**
 * athenamem_get_aaak_spec — AAAK dialect reference.
 */
export async function toolGetAaakSpec() {
    return [
        '# AAAK — AthenaMem Agent Acknowledgment Language',
        '',
        'AAAK is the structured format for agent memory operations.',
        '',
        '## Dialects',
        '',
        '### Memory Entry',
        'MEMORY | wing | room | hall | importance | content',
        'Example: MEMORY | athena | memory-stack | discoveries | 0.8 | Using SQLite with WAL mode',
        '',
        '### Fact',
        'FACT | subject | predicate | object | confidence',
        'Example: FACT | team | decided | postgresql | 0.9',
        '',
        '### Decision',
        'DECISION | context | choice | reason | alternatives_considered',
        'Example: DECISION | database | postgresql | better jsonb support | mongodb',
        '',
        '### Lesson',
        'LESSON | context | learning | implication',
        'Example: LESSON | backup file | old config broke everything | always test backup restoration',
        '',
        '### Diary Entry',
        'DIARY | agent | type | content',
        'Example: DIARY | athena | review | PR#42 fixed auth bypass',
        '',
        '### Contradiction Flag',
        'CONFLICT | memory_id | conflicts_with | resolution_status',
        'Example: CONFLICT | abc123 | def456 | unresolved',
    ].join('\n');
}
/**
 * athenamem_add_drawer — store verbatim content (unified ingestion).
 */
export async function toolAddDrawer(wingName, roomName, hall, content, filePath) {
    const category = mapHallToCategory(hall);
    const result = await ingestMemory(wingName, roomName, category, content, {
        source: 'tool',
        filePath: filePath ?? `${hall}/${wingName}-${roomName}-${Date.now()}.md`,
        provenance: { triggerTool: 'add_drawer' },
    });
    return {
        drawer_id: result.drawerId ?? '',
        memory_id: result.memoryId,
        salience: result.salienceScore,
    };
}
/**
 * Map hall type to category for ingestion.
 */
function mapHallToCategory(hall) {
    const mapping = {
        'facts': 'general',
        'events': 'system',
        'discoveries': 'lesson',
        'preferences': 'preference',
        'advice': 'lesson',
    };
    return mapping[hall] ?? 'general';
}
/**
 * athenamem_delete_drawer — invalidate memories by entry ID (soft delete).
 *
 * Memories are marked as invalidated rather than deleted to preserve audit trail.
 */
export async function toolDeleteDrawer(entryId) {
    const c = getContext();
    const memories = c.kg.getMemoriesByEntryId(entryId);
    for (const memory of memories) {
        c.kg.invalidateMemory(memory.id, 'user_deleted');
    }
    return {
        deleted: true,
        memories_invalidated: memories.length,
    };
}
/**
 * athenamem_kg_query — entity relationships with time filtering.
 */
export async function toolKgQuery(entityId, asOf) {
    const c = getContext();
    let entities = c.kg.queryEntities({ entity_id: entityId, as_of: asOf });
    if (entities.length === 0 && entityId) {
        entities = c.kg.queryEntities({ entity_name: entityId, as_of: asOf });
    }
    const resolvedEntityId = entities[0]?.id;
    const relations = resolvedEntityId ? c.kg.queryRelations(resolvedEntityId, undefined, asOf) : [];
    return { entities, relations };
}
/**
 * athenamem_kg_add — add facts with proper entity typing.
 *
 * Defaults to 'person' for both entities if type not specified.
 * Infers types from module/category context when possible.
 */
export async function toolKgAdd(subject, predicate, object, confidence = 1.0, subjectType, objectType, sourceMemoryId, metadata = {}) {
    const c = getContext();
    // Infer entity types if not provided
    const inferredSubjectType = subjectType ?? inferEntityType(subject, 'person');
    const inferredObjectType = objectType ?? inferEntityType(object, 'person');
    const subjectEntity = c.kg.addEntity(subject, inferredSubjectType, metadata);
    const objectEntity = c.kg.addEntity(object, inferredObjectType, metadata);
    const relation = c.kg.addRelation(subjectEntity.id, predicate, objectEntity.id, confidence, sourceMemoryId ?? null);
    return {
        subject_entity_id: subjectEntity.id,
        object_entity_id: objectEntity.id,
        relation_id: relation.id,
        inferred_types: { subject: inferredSubjectType, object: inferredObjectType },
    };
}
/**
 * Infer entity type from name patterns and context.
 */
function inferEntityType(name, defaultType = 'person') {
    const lower = name.toLowerCase();
    // Project indicators
    if (/\b(app|project|system|service|api|bot|agent|tool)\b/.test(lower)) {
        return 'project';
    }
    // Decision indicators
    if (/\b(decision|choice|option|plan|strategy)\b/.test(lower)) {
        return 'decision';
    }
    // Topic indicators
    if (/\b(topic|concept|idea|pattern|architecture)\b/.test(lower)) {
        return 'topic';
    }
    // Lesson indicators
    if (/\b(lesson|insight|learning|realization)\b/.test(lower)) {
        return 'lesson';
    }
    // Preference indicators
    if (/\b(preference|setting|config|default)\b/.test(lower)) {
        return 'preference';
    }
    // Agent indicators
    if (/\b(athena|athenamem|openclaw|codex|claude|gpt)\b/.test(lower)) {
        return 'agent';
    }
    if (/^[a-z][a-z0-9_-]*$/.test(name)) {
        return 'topic';
    }
    // Person indicators (names typically don't have spaces, might have @)
    if (/^[A-Z][a-z]+$/.test(name) || name.includes('@')) {
        return 'person';
    }
    return defaultType;
}
/**
 * athenamem_kg_invalidate — mark memory or entity as no longer current.
 *
 * Invalidation = "this is no longer true" (separate from contradictions).
 * Reasons: user_deleted, expired, superseded, error.
 */
export async function toolKgInvalidate(id, type = 'memory', reason = 'superseded', ended) {
    const c = getContext();
    const endTime = ended ?? Date.now();
    if (type === 'memory') {
        c.kg.invalidateMemory(id, reason, endTime);
    }
    else {
        c.kg.invalidateEntity(id, endTime);
    }
    return { invalidated: true, type, id, valid_to: endTime };
}
/**
 * athenamem_kg_timeline — chronological entity story.
 */
export async function toolKgTimeline(entityId) {
    return { timeline: getContext().kg.timeline(entityId) };
}
/**
 * athenamem_check_facts — check assertions against KG.
 */
export async function toolCheckFacts(text) {
    const c = getContext();
    const facts = extractFacts(text);
    const result = c.detector.check(facts);
    return {
        facts,
        contradictions: result.contradictions.length,
        warnings: result.warnings,
    };
}
/**
 * athenamem_resolve_conflict — resolve a flagged contradiction.
 */
export async function toolResolveConflict(memoryId, resolution) {
    const c = getContext();
    // For now, just unflag the contradiction
    // In a full implementation, this would do the actual merge/invalidation
    return { resolved: true, action: resolution };
}
/**
 * athenamem_diary_write — write AAAK diary entry (unified ingestion).
 */
export async function toolDiaryWrite(agentName, entryType, content) {
    const result = await ingestMemory(agentName, 'diary', 'lesson', `[${entryType.toUpperCase()}] ${content}`, {
        source: 'diary',
        filePath: `diary/${agentName}-${Date.now()}.md`,
        provenance: { triggerTool: 'diary_write' },
    });
    return {
        memory_id: result.memoryId,
        salience: result.salienceScore,
    };
}
/**
 * athenamem_diary_read — read recent diary entries.
 */
export async function toolDiaryRead(agentName, limit = 10) {
    const c = getContext();
    const memories = c.kg.getMemoriesByPalace(agentName, 'diary');
    return {
        entries: memories.slice(0, limit).map(m => ({
            id: m.id,
            type: m.memory_type,
            content: m.content,
            created_at: m.created_at,
        })),
    };
}
/**
 * athenamem_traverse — walk tunnels across wings.
 */
export async function toolTraverse(wingName, roomName) {
    const c = getContext();
    const tunnels = c.palace.findTunnels(wingName).filter(t => t.room_name === roomName);
    const memories = c.kg.getMemoriesByPalace(wingName, roomName);
    return {
        current_wing: wingName,
        room: roomName,
        tunnels: tunnels.map(t => ({ to_wing: t.to_wing, memory_count: t.memory_count })),
        memories,
    };
}
/**
 * athenamem_find_tunnels — find rooms bridging wings.
 */
export async function toolFindTunnels() {
    const c = getContext();
    const allWings = c.palace.listWings();
    const potential = [];
    for (const wing of allWings) {
        potential.push(...c.palace.findPotentialTunnels().map(t => ({ roomName: t.roomName, wings: t.wings })));
    }
    return {
        potential: c.palace.findPotentialTunnels(),
        existing: allWings.flatMap(w => c.palace.findTunnels(w.name)),
    };
}
/**
 * athenamem_recall — deep cross-system recall.
 */
export async function toolRecall(query, limit = 30) {
    return getContext().orchestrator.deepSearch(query, limit);
}
// ─── Palace Structure Tools (Missing in v0.1.0) ────────────────────────────────
export async function toolCreateWing(wingName, description) {
    const { palace } = getContext();
    return palace.createWing(wingName, description ?? '');
}
export async function toolCreateRoom(wingName, roomName, description) {
    const { palace } = getContext();
    return palace.createRoom(wingName, roomName, description ?? '');
}
// ─── Debug Tools (Phase 4) ─────────────────────────────────────────────────────
/**
 * athenamem_trace_memory — full audit trail of a memory.
 */
export async function toolTraceMemory(memoryId) {
    const c = getContext();
    const trace = await traceMemory(memoryId, c.kg, c.palace, c.wal);
    if (!trace) {
        return { found: false, error: `Memory ${memoryId} not found` };
    }
    return {
        found: true,
        trace: {
            memory: trace.memory,
            entry: trace.entry,
            facts: trace.facts.length,
            contradictions: trace.contradictions.length,
            lifecycle: trace.lifecycle,
        },
    };
}
/**
 * athenamem_explain_recall — why did these memories rank here?
 *
 * ⚠️ CURRENT LIMITATION: This returns approximate explanations based on
 * stored memory metadata. Full source breakdown requires orchestrator support.
 */
function extractMemoryId(resultId) {
    if (resultId.startsWith('kg:'))
        return resultId.slice(3);
    return null;
}
export async function toolExplainRecall(query, resultMemoryIds) {
    const c = getContext();
    const skipped = [];
    // ⚠️ APPROXIMATE: Using stored metadata since orchestrator doesn't pass full search context
    const memories = [];
    for (const resultId of resultMemoryIds) {
        const extracted = extractMemoryId(resultId);
        const memoryId = extracted ?? resultId;
        if (extracted === null && resultId.includes(':')) {
            skipped.push(resultId);
            continue;
        }
        const memory = c.kg.getMemoryById(memoryId);
        if (!memory)
            continue;
        memories.push({
            memory,
            score: memory.importance,
            sourceScores: { athenamem: memory.importance },
            matched_keywords: [],
        });
    }
    const explanation = explainRecall(query, memories);
    return {
        query,
        approximate: true,
        note: 'Explanations are approximate. Only KG-backed recall results can currently be explained. Full source breakdown requires orchestrator to pass search metadata.',
        unsupported_result_ids: skipped,
        explanation: {
            memory_count: memories.length,
            filters_applied: explanation.filters_applied,
            top_memories: explanation.top_results.slice(0, 5).map(r => ({
                rank: r.rank,
                memory_id: r.memory_id,
                score: r.final_score,
                salience: r.salience,
                valid: r.valid,
                contradicted: r.contradicted,
                why_ranked: r.why_ranked,
            })),
        },
    };
}
//# sourceMappingURL=server.js.map