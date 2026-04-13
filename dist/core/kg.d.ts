/**
 * AthenaMem Knowledge Graph
 *
 * Temporal entity-relation graph with validity windows.
 * Inspired by MemPalace's KG + Hindsight's biomimetic structure.
 *
 * Entities have validity windows — queries can ask "what was true at time X?"
 * Every fact is traceable to a source drawer.
 */
import { z } from 'zod';
export declare const EntityTypeSchema: z.ZodEnum<["person", "project", "topic", "decision", "lesson", "event", "preference", "agent"]>;
export type EntityType = z.infer<typeof EntityTypeSchema>;
export declare const PredicateSchema: z.ZodEnum<["works_on", "decided", "prefers", "learned", "assigned_to", "completed", "conflicts_with", "related_to", "created", "updated", "failed", "succeeded", "recommended", "rejected", "mentioned", "owns", "depends_on"]>;
export type Predicate = z.infer<typeof PredicateSchema>;
export declare const MemoryTypeSchema: z.ZodEnum<["conversation", "decision", "lesson", "event", "preference", "fact", "discovery", "advice"]>;
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export declare const HallTypeSchema: z.ZodEnum<["facts", "events", "discoveries", "preferences", "advice"]>;
export type HallType = z.infer<typeof HallTypeSchema>;
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
    drawer_id: string;
    content: string;
    summary: string | null;
    memory_type: MemoryType;
    room: string;
    wing: string;
    importance: number;
    contradiction_flag: boolean;
    contradiction_with: string | null;
    created_at: number;
    last_accessed: number | null;
    access_count: number;
}
export interface Drawer {
    drawer_id: string;
    wing: string;
    room: string;
    hall: HallType;
    file_path: string;
    content_hash: string;
    created_at: number;
}
export interface TemporalQuery {
    entity_id?: string;
    as_of?: number;
    include_expired?: boolean;
}
export interface KGStats {
    entity_count: number;
    relation_count: number;
    memory_count: number;
    drawer_count: number;
    active_entities: number;
    contradictions: number;
}
export declare class KnowledgeGraph {
    private db;
    private _dbPath;
    constructor(dbPath: string);
    private init;
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
     * Get all facts about an entity — both incoming and outgoing relations.
     */
    getEntityFacts(entityId: string, asOf?: number): {
        outgoing: Relation[];
        incoming: Relation[];
    };
    /**
     * Store a memory item, linked to a drawer.
     */
    addMemory(drawerId: string, content: string, memoryType: MemoryType, room: string, wing: string, summary?: string | null, importance?: number): Memory;
    /**
     * Search memories using FTS5.
     */
    searchMemories(query: string, wing?: string, room?: string, limit?: number): Memory[];
    /**
     * Get memories by wing and room (palace navigation).
     */
    getMemoriesByPalace(wing: string, room?: string, hall?: HallType): Memory[];
    /**
     * Mark a memory as contradictory.
     */
    flagContradiction(memoryId: string, conflictingMemoryId: string): void;
    /**
     * Record an access — updates last_accessed and increments access_count.
     */
    recordAccess(memoryId: string): void;
    /**
     * Register a drawer (a file containing verbatim content).
     */
    addDrawer(wing: string, room: string, hall: HallType, filePath: string, contentHash: string): Drawer;
    /**
     * Get drawer by path.
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
        drawers: Drawer[];
    };
    /**
     * Import KG from JSON (for restore/migration).
     */
    import(data: {
        entities: Entity[];
        relations: Relation[];
        memories: Memory[];
        drawers: Drawer[];
    }): void;
}
//# sourceMappingURL=kg.d.ts.map