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
import { KnowledgeGraph, Entity, Relation, Memory, EntityType, HallType, Predicate } from '../core/kg.js';
import { Palace, Wing, Room, Tunnel } from '../core/palace.js';
import { WALManager } from '../core/wal.js';
import { ContradictionDetector } from '../core/contradiction.js';
import { CompactionEngine } from '../core/compaction.js';
import { SearchOrchestrator, SearchResult, SearchResponse } from '../search/orchestrator.js';
import { CategoryType, MemorySource, IngestionResult } from '../core/event.js';
export interface AthenaMemConfig {
    data_dir: string;
    palace_dir: string;
    compact_on_flush: boolean;
    contradiction_check: boolean;
    auto_wal: boolean;
    qmd_path: string;
    clawvault_path: string;
    hindsight_url: string;
    mnemo_url: string;
}
export interface PluginContext {
    config: AthenaMemConfig;
    kg: KnowledgeGraph;
    palace: Palace;
    wal: WALManager;
    detector: ContradictionDetector;
    compaction: CompactionEngine;
    orchestrator: SearchOrchestrator;
    sessionId: string;
    agentId: string;
    initialized: boolean;
}
export declare function getContext(): PluginContext;
export declare function init(config?: Partial<AthenaMemConfig>): Promise<void>;
export declare function setSession(sessionId: string, agentId: string): void;
/**
 * on_agent_boot — called when the agent starts.
 * Loads L0 (identity) and L1 (critical facts) into context.
 * Checks for uncommitted WAL entries from a crash.
 */
export declare function onAgentBoot(): Promise<{
    context: string;
    recovered: boolean;
    l0_l1_summary: string;
}>;
/**
 * on_agent_sleep — called when the agent shuts down.
 * Writes final checkpoint and updates KG.
 */
export declare function onAgentSleep(summary?: string): Promise<{
    checkpoint_id: string;
}>;
/**
 * on_turn — called before every agent response.
 * Enforces WAL: writes state BEFORE responding.
 */
export declare function onTurn(contextState: string): Promise<{
    wal_id: string;
}>;
/**
 * on_commit — called after successful agent response.
 * Marks WAL entry as committed.
 */
export declare function onCommit(): Promise<void>;
/**
 * on_flush — called before context window flush.
 * Runs DAG compaction and updates active frontier.
 */
export declare function onFlush(): Promise<{
    compacted: number;
    new_frontier_nodes: number;
}>;
/**
 * Unified memory ingestion — THE single entry point for all memory writes.
 *
 * All tools that create memory must use this function.
 * It provides durability, auditability, salience scoring, and KG updates.
 */
export declare function ingestMemory(module: string, section: string, category: CategoryType, content: string, options?: {
    source?: MemorySource;
    filePath?: string;
    confidence?: number;
    salienceOverride?: number;
    provenance?: {
        triggerTool?: string;
        parentMemoryIds?: string[];
    };
    skipContradictionCheck?: boolean;
}): Promise<IngestionResult>;
/**
 * athenamem_status — L0-L4 overview + AAAK spec.
 */
export declare function toolStatus(): Promise<string>;
/**
 * athenamem_list_wings — all wings with counts.
 */
export declare function toolListWings(): Promise<Wing[]>;
/**
 * athenamem_list_rooms — rooms within a wing.
 */
export declare function toolListRooms(wingName: string): Promise<Room[]>;
/**
 * athenamem_search — hybrid search with wing/room filters.
 */
export declare function toolSearch(query: string, wing?: string, room?: string, limit?: number): Promise<SearchResult[]>;
/**
 * athenamem_get_aaak_spec — AAAK dialect reference.
 */
export declare function toolGetAaakSpec(): Promise<string>;
/**
 * athenamem_add_drawer — store verbatim content (unified ingestion).
 */
export declare function toolAddDrawer(wingName: string, roomName: string, hall: HallType, content: string, filePath?: string, salience?: number): Promise<{
    drawer_id: string;
    memory_id: string;
    salience: number;
}>;
/**
 * athenamem_delete_drawer — invalidate memories by entry ID (soft delete).
 *
 * Memories are marked as invalidated rather than deleted to preserve audit trail.
 */
export declare function toolDeleteDrawer(entryId: string): Promise<{
    deleted: boolean;
    memories_invalidated: number;
}>;
/**
 * athenamem_kg_query — entity relationships with time filtering.
 */
export declare function toolKgQuery(entityId?: string, asOf?: number): Promise<{
    entities: Entity[];
    relations: Relation[];
}>;
/**
 * athenamem_kg_add — add facts with proper entity typing.
 *
 * Defaults to 'person' for both entities if type not specified.
 * Infers types from module/category context when possible.
 */
export declare function toolKgAdd(subject: string, predicate: Predicate, object: string, confidence?: number, subjectType?: EntityType, objectType?: EntityType, sourceMemoryId?: string, metadata?: Record<string, unknown>): Promise<{
    subject_entity_id: string;
    object_entity_id: string;
    relation_id: string;
    inferred_types: {
        subject: EntityType;
        object: EntityType;
    };
}>;
/**
 * athenamem_kg_invalidate — mark memory or entity as no longer current.
 *
 * Invalidation = "this is no longer true" (separate from contradictions).
 * Reasons: user_deleted, expired, superseded, error.
 */
export declare function toolKgInvalidate(id: string, type?: 'memory' | 'entity', reason?: 'user_deleted' | 'expired' | 'superseded' | 'error', ended?: number): Promise<{
    invalidated: boolean;
    type: string;
    id: string;
    valid_to: number;
}>;
/**
 * athenamem_kg_timeline — chronological entity story.
 */
export declare function toolKgTimeline(entityId: string): Promise<{
    timeline: {
        time: number;
        event: string;
        type: string;
    }[];
}>;
/**
 * athenamem_check_facts — check assertions against KG.
 */
export declare function toolCheckFacts(text: string): Promise<{
    facts: {
        subject: string;
        predicate: string;
        object: string;
        confidence: number;
    }[];
    contradictions: number;
    warnings: string[];
}>;
/**
 * athenamem_resolve_conflict — resolve a flagged contradiction.
 */
export declare function toolResolveConflict(memoryId: string, resolution: 'keep_new' | 'keep_old' | 'merge' | 'invalidate_old'): Promise<{
    resolved: boolean;
    action: string;
}>;
/**
 * athenamem_diary_write — write AAAK diary entry (unified ingestion).
 */
export declare function toolDiaryWrite(agentName: string, entryType: string, content: string): Promise<{
    memory_id: string;
    salience: number;
}>;
export declare function toolDeleteWing(wingName: string): Promise<{
    deleted: boolean;
    rooms_removed: number;
    memories_invalidated: number;
}>;
/**
 * athenamem_diary_read — read recent diary entries.
 */
export declare function toolDiaryRead(agentName: string, limit?: number): Promise<{
    entries: {
        id: string;
        type: string;
        content: string;
        created_at: number;
    }[];
}>;
/**
 * athenamem_traverse — walk tunnels across wings.
 */
export declare function toolTraverse(wingName: string, roomName: string): Promise<{
    current_wing: string;
    room: string;
    tunnels: {
        to_wing: string;
        memory_count: number;
    }[];
    memories: Memory[];
}>;
/**
 * athenamem_find_tunnels — find rooms bridging wings.
 */
export declare function toolFindTunnels(): Promise<{
    potential: {
        roomName: string;
        wings: string[];
    }[];
    existing: Tunnel[];
}>;
/**
 * athenamem_recall — deep cross-system recall.
 */
export declare function toolRecall(query: string, limit?: number): Promise<SearchResponse>;
export declare function toolCreateWing(wingName: string, description?: string): Promise<Wing>;
export declare function toolCreateRoom(wingName: string, roomName: string, description?: string): Promise<Room>;
/**
 * athenamem_trace_memory — full audit trail of a memory.
 */
export declare function toolTraceMemory(memoryId: string): Promise<{
    found: boolean;
    trace?: {
        memory: Memory;
        entry: {
            file_path: string;
            content_hash: string;
        } | null;
        facts: number;
        contradictions: number;
        lifecycle: {
            created: number;
            last_accessed: number | null;
            access_count: number;
            status: string;
        };
    };
    error?: string;
}>;
export declare function toolExplainRecall(query: string, resultMemoryIds: string[]): Promise<{
    query: string;
    approximate: boolean;
    note: string;
    unsupported_result_ids: string[];
    explanation: {
        memory_count: number;
        filters_applied: string[];
        top_memories: Array<{
            rank: number;
            memory_id: string;
            score: number;
            salience: number;
            valid: boolean;
            contradicted: boolean;
            why_ranked: string[];
        }>;
    };
}>;
//# sourceMappingURL=server.d.ts.map