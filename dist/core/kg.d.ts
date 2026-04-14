/**
 * AthenaMem Core Knowledge Graph
 *
 * Temporal entity-relation graph with validity windows.
 * Inspired by MemPalace's KG + Hindsight's biomimetic structure.
 *
 * Entities have validity windows — queries can ask "what was true at time X?"
 * Every fact is traceable to a source entry.
 */
import { z } from 'zod';
export declare const EntityTypeSchema: z.ZodEnum<["person", "project", "topic", "decision", "lesson", "event", "preference", "agent"]>;
export type EntityType = z.infer<typeof EntityTypeSchema>;
export declare const PredicateSchema: z.ZodEnum<["works_on", "decided", "prefers", "learned", "assigned_to", "completed", "conflicts_with", "related_to", "created", "updated", "failed", "succeeded", "recommended", "rejected", "mentioned", "owns", "depends_on"]>;
export type Predicate = z.infer<typeof PredicateSchema>;
export declare const MemoryTypeSchema: z.ZodEnum<["conversation", "decision", "lesson", "event", "preference", "fact", "discovery", "advice"]>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export declare const CategoryTypeSchema: z.ZodEnum<["facts", "events", "discoveries", "preferences", "advice"]>;
export type CategoryType = z.infer<typeof CategoryTypeSchema>;
export interface Entity {
    id: string;
    name: string;
    type: EntityType;
    created_at: number;
    valid_from: number;
    valid_to: number | null;
    metadata: Record<string, unknown>;
}
export interface Relation {
    id: string;
    subject_id: string;
    predicate: Predicate;
    object_id: string;
    valid_from: number;
    valid_to: number | null;
    confidence: number;
    source: string | null;
    created_at: number;
}
export interface Memory {
    id: string;
    entry_id: string;
    content: string;
    summary: string | null;
    memory_type: MemoryType;
    section: string;
    module: string;
    importance: number;
    contradiction_flag: boolean;
    contradiction_with: string | null;
    status: 'active' | 'invalidated' | 'compacted' | 'archived';
    valid_to: number | null;
    created_at: number;
    last_accessed: number | null;
    access_count: number;
}
export interface Drawer {
    drawer_id: string;
    wing: string;
    room: string;
    hall: CategoryType;
    file_path: string;
    content_hash: string;
    created_at: number;
}
export interface Entry {
    entry_id: string;
    module: string;
    section: string;
    category: CategoryType;
    file_path: string;
    content_hash: string;
    created_at: number;
}
export type HallType = CategoryType;
export interface TemporalQuery {
    entity_id?: string;
    as_of?: number;
    include_expired?: boolean;
}
export interface KGStats {
    entity_count: number;
    relation_count: number;
    memory_count: number;
    entry_count: number;
    active_entities: number;
    contradictions: number;
}
export declare class KnowledgeGraph {
    private db;
    private _dbPath;
    constructor(dbPath: string);
    private init;
    /**
     * Database migrations for schema updates.
     */
    private migrate;
    /**
     * Add a new entity. If one with the same name+type already exists and is active,
     * returns the existing entity instead of creating a duplicate.
     */
    addEntity(name: string, type: EntityType, metadata?: Record<string, unknown>): Entity;
    /**
     * Query entities. Supports temporal filtering via `as_of`.
     * If as_of is set, only returns entities that were valid at that time.
     */
    queryEntities(query?: TemporalQuery): Entity[];
    /**
     * Get entity by name and type.
     */
    getEntity(name: string, type: EntityType): Entity | null;
    /**
     * Invalidate an entity — marks it as no longer current.
     * Historical queries will still see it; current queries won't.
     */
    invalidateEntity(entityId: string, ended?: number): void;
    /**
     * Add a relation between two entities.
     */
    addRelation(subjectId: string, predicate: Predicate, objectId: string, confidence?: number, source?: string | null): Relation;
    /**
     * Query relations. Supports temporal filtering.
     */
    queryRelations(subjectId?: string, predicate?: Predicate, asOf?: number): Relation[];
    /**
     * Get all relations where source matches a memory ID.
     * This is used to trace facts derived from a specific memory.
     */
    getRelationsBySource(sourceId: string): Relation[];
    /**
     * Get all facts about an entity — both incoming and outgoing relations.
     */
    getEntityFacts(entityId: string, asOf?: number): {
        outgoing: Relation[];
        incoming: Relation[];
    };
    /**
     * Store a memory item, linked to an entry.
     */
    addMemory(entryId: string, content: string, memoryType: MemoryType, section: string, module: string, summary?: string | null, importance?: number): Memory;
    /**
     * Search memories using FTS5.
     * Falls back to LIKE query if FTS returns no results.
     */
    searchMemories(query: string, module?: string, section?: string, limit?: number): Memory[];
    /**
     * Rebuild the FTS5 index from scratch.
     * Use when FTS is out of sync or returning no results.
     */
    rebuildFTSIndex(): void;
    /**
     * Get memories by module and section (structure navigation).
     */
    getMemoriesByStructure(module: string, section?: string, category?: CategoryType): Memory[];
    /**
     * Legacy method: Get memories by wing and room (palace navigation).
     * Maps to new structure terminology.
     */
    getMemoriesByPalace(wing: string, room?: string, hall?: CategoryType): Memory[];
    /**
     * Mark a memory as contradictory.
     */
    flagContradiction(memoryId: string, conflictingMemoryId: string): void;
    /**
     * Record an access — updates last_accessed and increments access_count.
     */
    recordAccess(memoryId: string): void;
    /**
     * Register an entry (a file containing verbatim content).
     */
    addEntry(module: string, section: string, category: CategoryType, filePath: string, contentHash: string): Entry;
    /**
     * Legacy method: Register a drawer (maps to entry).
     */
    addDrawer(wing: string, room: string, hall: CategoryType, filePath: string, contentHash: string): Drawer;
    /**
     * Get entry by path.
     */
    getEntry(filePath: string): Entry | null;
    /**
     * Get entry by ID.
     */
    getEntryById(entryId: string): Entry | null;
    /**
     * Get memories by entry ID (for drawer invalidation).
     */
    getMemoriesByEntryId(entryId: string): Memory[];
    /**
     * Legacy method: Get drawer by path.
     */
    getDrawer(filePath: string): Drawer | null;
    /**
     * Get chronological story of an entity — all facts about it in time order.
     */
    timeline(entityId: string): {
        time: number;
        event: string;
        type: 'entity' | 'relation';
    }[];
    stats(): KGStats;
    private parseEntity;
    /**
     * Close the database connection.
     */
    close(): void;
    /**
     * Export entire KG as JSON (for backup/migration).
     */
    export(): {
        entities: Entity[];
        relations: Relation[];
        memories: Memory[];
        entries: Entry[];
        drawers: Drawer[];
    };
    /**
     * Import KG from JSON (for restore/migration).
     */
    import(data: {
        entities: Entity[];
        relations: Relation[];
        memories: Memory[];
        entries?: Entry[];
        drawers?: Drawer[];
    }): void;
    /**
     * Update memory salience score.
     */
    updateMemorySalience(memoryId: string, salience: number): void;
    /**
     * Update memory access count and last_accessed.
     */
    touchMemory(memoryId: string): void;
    /**
     * Invalidate a memory — mark it as no longer current.
     * Separate from contradiction (which marks an actual conflict).
     */
    invalidateMemory(memoryId: string, reason: 'user_deleted' | 'expired' | 'superseded' | 'error', ended?: number): void;
    /**
     * Get a memory by ID.
     */
    getMemoryById(memoryId: string): Memory | null;
    /**
     * Get recent memories across all wings/rooms.
     */
    getRecentMemories(limit?: number): Memory[];
    /**
     * Get memories by status (for compaction, cleanup).
     */
    getMemoriesByStatus(status: Memory['status'], limit?: number): Memory[];
}
//# sourceMappingURL=kg.d.ts.map