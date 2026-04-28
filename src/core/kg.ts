/**
 * AthenaMem Core Knowledge Graph
 * 
 * Temporal entity-relation graph with validity windows.
 * Inspired by MemPalace's KG + Hindsight's biomimetic structure.
 * 
 * Entities have validity windows — queries can ask "what was true at time X?"
 * Every fact is traceable to a source entry.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { ConfidenceStore, DecayReport } from './confidence.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const ENTITY_TYPES = [
  'person', 'project', 'topic', 'decision', 'lesson', 'event', 'preference', 'agent', 'date', 'location'
] as const;

export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const PREDICATES = [
  'works_on', 'decided', 'prefers', 'learned', 'assigned_to', 'completed',
  'conflicts_with', 'related_to', 'created', 'updated', 'failed', 'succeeded',
  'recommended', 'rejected', 'mentioned', 'owns', 'depends_on',
  'is_a', 'born_in', 'located_in', 'started_on', 'ended_on'
] as const;

export const PredicateSchema = z.enum(PREDICATES);
export type Predicate = z.infer<typeof PredicateSchema>;

export const MemoryTypeSchema = z.enum([
  'conversation', 'decision', 'lesson', 'event', 'preference', 'fact', 'discovery', 'advice'
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const CategoryTypeSchema = z.enum([
  'facts', 'events', 'discoveries', 'preferences', 'advice'
]);
export type CategoryType = z.infer<typeof CategoryTypeSchema>;

const ENTITY_TYPE_SQL = ENTITY_TYPES.map((type) => `'${type}'`).join(',');
const PREDICATE_SQL = PREDICATES.map((predicate) => `'${predicate}'`).join(',');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  created_at: number;
  valid_from: number;
  valid_to: number | null;  // null = still active
  metadata: Record<string, unknown>;
  // Confidence system (added in v0.3)
  confidence: number;
  last_accessed: number | null;
  access_count: number;
  status: 'active' | 'dormant' | 'archived';
  area: string | null;
}

export interface Relation {
  id: string;
  subject_id: string;
  predicate: Predicate;
  object_id: string;
  valid_from: number;
  valid_to: number | null;
  confidence: number;
  source: string | null;  // entry_id
  created_at: number;
  // Confidence system (added in v0.3)
  last_accessed: number | null;
  access_count: number;
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
  
  // Contradiction tracking (actual conflicts)
  contradiction_flag: boolean;
  contradiction_with: string | null;
  
  // Memory lifecycle status (separate from contradictions)
  status: 'active' | 'invalidated' | 'compacted' | 'archived';
  valid_to: number | null;  // When invalidated/ended (null = still active)
  
  // Timestamps
  created_at: number;
  last_accessed: number | null;
  access_count: number;
}

// Legacy Drawer type - kept for backwards compatibility
export interface Drawer {
  drawer_id: string;
  wing: string;
  room: string;
  hall: CategoryType;
  file_path: string;
  content_hash: string;
  created_at: number;
}

// New Entry type - replaces Drawer
export interface Entry {
  entry_id: string;
  module: string;
  section: string;
  category: CategoryType;
  file_path: string;
  content_hash: string;
  created_at: number;
}

// Legacy HallType alias for backwards compatibility
export type HallType = CategoryType;

export interface TemporalQuery {
  entity_id?: string;
  entity_name?: string;
  as_of?: number;  // unix timestamp, defaults to now
  include_expired?: boolean;
  include_stale?: boolean;  // if true, includes dormant/archived entities (default: false)
}

export interface KGStats {
  entity_count: number;
  relation_count: number;
  memory_count: number;
  entry_count: number;
  active_entities: number;
  contradictions: number;
}

// ─── KnowledgeGraph Class ─────────────────────────────────────────────────────

export class KnowledgeGraph {
  private db: Database.Database;
  private _dbPath: string;
  private _confidenceStore: ConfidenceStore | null = null;

  constructor(dbPath: string, confidenceStore?: ConfidenceStore) {
    this._dbPath = dbPath;
    this._confidenceStore = confidenceStore ?? null;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  /**
   * Attach a ConfidenceStore to this KG (can be done post-construction).
   */
  setConfidenceStore(store: ConfidenceStore): void {
    this._confidenceStore = store;
  }
  get confidence(): ConfidenceStore | null {
    return this._confidenceStore;
  }

  private init(): void {
    this.db.exec(`
      -- Entities: people, projects, topics, decisions, lessons, etc.
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (${ENTITY_TYPE_SQL})),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_to INTEGER,
        metadata JSON DEFAULT '{}'
      );

      -- Relations between entities
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES entities(id),
        predicate TEXT NOT NULL CHECK (predicate IN (${PREDICATE_SQL})),
        object_id TEXT NOT NULL REFERENCES entities(id),
        valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_to INTEGER,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Memory items (verbatim + derived)
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        memory_type TEXT NOT NULL CHECK (memory_type IN (
          'conversation','decision','lesson','event','preference','fact','discovery','advice'
        )),
        section TEXT NOT NULL,
        module TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        
        -- Contradiction tracking (actual conflicts)
        contradiction_flag INTEGER NOT NULL DEFAULT 0,
        contradiction_with TEXT,
        
        -- Memory lifecycle status (separate from contradictions)
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalidated', 'compacted', 'archived')),
        valid_to INTEGER,
        
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        last_accessed INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      -- Entries (verbatim storage) - replaces drawers
      CREATE TABLE IF NOT EXISTS entries (
        entry_id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        section TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('facts','events','discoveries','preferences','advice')),
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Legacy drawers table for backwards compatibility
      CREATE TABLE IF NOT EXISTS drawers (
        drawer_id TEXT PRIMARY KEY,
        wing TEXT NOT NULL,
        room TEXT NOT NULL,
        hall TEXT NOT NULL CHECK (hall IN ('facts','events','discoveries','preferences','advice')),
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Validity windows for temporal queries
      CREATE TABLE IF NOT EXISTS validity_windows (
        entity_id TEXT NOT NULL REFERENCES entities(id),
        valid_from INTEGER NOT NULL,
        valid_to INTEGER,
        PRIMARY KEY (entity_id, valid_from)
      );

      -- FTS5 index on memory content for fast full-text search
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_valid ON entities(valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject_id);
      CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(object_id);
      CREATE INDEX IF NOT EXISTS idx_relations_predicate ON relations(predicate);
      CREATE INDEX IF NOT EXISTS idx_memories_module_section ON memories(module, section);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_contradiction ON memories(contradiction_flag) WHERE contradiction_flag = 1;
      -- idx_memories_status created in migrate() after column is added
      CREATE INDEX IF NOT EXISTS idx_entries_module ON entries(module);
      CREATE INDEX IF NOT EXISTS idx_drawers_wing ON drawers(wing);
    `);
    
    // Run migrations for existing databases
    this.migrate();
  }
  
  /**
   * Database migrations for schema updates.
   */
  private migrate(): void {
    const entitiesTable = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entities'
    `).get() as { sql?: string } | undefined;
    const missingEntityTypes = ENTITY_TYPES.filter((type) => !entitiesTable?.sql?.includes(`'${type}'`));

    if (missingEntityTypes.length > 0) {
      this.db.exec(`
        ALTER TABLE entities RENAME TO entities_old;

        CREATE TABLE entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN (${ENTITY_TYPE_SQL})),
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          valid_to INTEGER,
          metadata JSON DEFAULT '{}',
          confidence REAL NOT NULL DEFAULT 1.0,
          last_accessed INTEGER,
          access_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'archived')),
          area TEXT
        );

        INSERT INTO entities (id, name, type, created_at, valid_from, valid_to, metadata, confidence, last_accessed, access_count, status, area)
        SELECT id, name, type, created_at, valid_from, valid_to, metadata,
               COALESCE(confidence, 1.0), last_accessed, COALESCE(access_count, 0),
               COALESCE(status, 'active'), area
        FROM entities_old;

        DROP TABLE entities_old;
      `);
    }

    const relationsTable = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'relations'
    `).get() as { sql?: string } | undefined;
    const missingPredicates = PREDICATES.filter((predicate) => !relationsTable?.sql?.includes(`'${predicate}'`));

    if (missingPredicates.length > 0) {
      this.db.exec(`
        ALTER TABLE relations RENAME TO relations_old;

        CREATE TABLE relations (
          id TEXT PRIMARY KEY,
          subject_id TEXT NOT NULL REFERENCES entities(id),
          predicate TEXT NOT NULL CHECK (predicate IN (${PREDICATE_SQL})),
          object_id TEXT NOT NULL REFERENCES entities(id),
          valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          valid_to INTEGER,
          confidence REAL NOT NULL DEFAULT 1.0,
          source TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_accessed INTEGER,
          access_count INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO relations (id, subject_id, predicate, object_id, valid_from, valid_to, confidence, source, created_at, last_accessed, access_count)
        SELECT id, subject_id, predicate, object_id, valid_from, valid_to,
               COALESCE(confidence, 1.0), source, created_at, last_accessed, COALESCE(access_count, 0)
        FROM relations_old;

        DROP TABLE relations_old;
      `);
    }

    const memoryColumns = this.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    const memoryColNames = new Set(memoryColumns.map((col) => col.name));

    if (!memoryColNames.has('status')) {
      this.db.exec(`
        ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'invalidated', 'compacted', 'archived'));
      `);
    }

    if (!memoryColNames.has('valid_to')) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN valid_to INTEGER;`);
    }

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status) WHERE status != 'active';`);

    // v0.3: Add entity-level confidence fields
    const entityColumns = this.db.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>;
    const entityColNames = new Set(entityColumns.map((col) => col.name));

    if (!entityColNames.has('confidence')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;`);
    }
    if (!entityColNames.has('last_accessed')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN last_accessed INTEGER;`);
    }
    if (!entityColNames.has('access_count')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!entityColNames.has('status')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'archived'));`);
    }
    if (!entityColNames.has('area')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN area TEXT;`);
    }

    // v0.3: Add relation-level access tracking
    const relColumns = this.db.prepare(`PRAGMA table_info(relations)`).all() as Array<{ name: string }>;
    const relColNames = new Set(relColumns.map((col) => col.name));

    if (!relColNames.has('last_accessed')) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN last_accessed INTEGER;`);
    }
    if (!relColNames.has('access_count')) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;`);
    }

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence) WHERE confidence < 1.0;`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status) WHERE status != 'active';`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_valid ON entities(valid_from, valid_to);`);
  }

  // ─── Entity Operations ──────────────────────────────────────────────────────

  /**
   * Add a new entity. If one with the same name+type already exists and is active,
   * returns the existing entity instead of creating a duplicate.
   */
  addEntity(name: string, type: EntityType, metadata: Record<string, unknown> = {}): Entity {
    const existing = this.db.prepare(`
      SELECT * FROM entities WHERE name = ? AND type = ? AND valid_to IS NULL
    `).get(name, type) as Entity | undefined;

    if (existing) return existing;

    const id = uuidv4();
    const now = Date.now();
    const meta = JSON.stringify(metadata);

    this.db.prepare(`
      INSERT INTO entities (id, name, type, created_at, valid_from, metadata, confidence, last_accessed, access_count, status)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, NULL, 0, 'active')
    `).run(id, name, type, now, now, meta);

    return { id, name, type, created_at: now, valid_from: now, valid_to: null, metadata, confidence: 1.0, last_accessed: null, access_count: 0, status: 'active', area: null };
  }

  /**
   * Query entities. Supports temporal filtering via `as_of`.
   * If as_of is set, only returns entities that were valid at that time.
   */
  queryEntities(query: TemporalQuery = {}): Entity[] {
    const { entity_id, entity_name, as_of = Date.now(), include_expired = false, include_stale = false } = query;

    if (entity_id) {
      const sql = include_expired
        ? 'SELECT * FROM entities WHERE id = ?'
        : 'SELECT * FROM entities WHERE id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
      const params: (string | number)[] = include_expired ? [entity_id] : [entity_id, as_of, as_of];
      const row = (this.db.prepare(sql).get(...params) as Entity | undefined);
      if (!row) return [];
      const entity = this.parseEntity(row);
      // Track access on returned entity
      if (!include_stale) {
        if (this._confidenceStore) {
          this._confidenceStore.recordEntityAccess(entity.id);
          this._confidenceStore.adjustEntityConfidence(entity.id, 0.01, 'usage_accumulation', 'kg_query');
        } else {
          this.db.prepare(`UPDATE entities SET access_count = COALESCE(access_count,0)+1, last_accessed = ? WHERE id = ?`).run(Date.now(), entity.id);
        }
      }
      return [entity];
    }

    const staleFilter = include_stale ? '' : "AND status = 'active' ";

    if (entity_name) {
      const sql = include_expired
        ? `SELECT * FROM entities WHERE lower(name) = lower(?) ${staleFilter}ORDER BY created_at ASC`
        : `SELECT * FROM entities WHERE lower(name) = lower(?) AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ? ${staleFilter}ORDER BY created_at ASC`;
      const params: (string | number)[] = include_expired ? [entity_name] : [entity_name, as_of, as_of];
      const rows = (this.db.prepare(sql).all(...params) as Entity[]);
      if (!include_stale && rows.length > 0) {
        const now = Date.now();
        for (const r of rows) {
          if (this._confidenceStore) {
            this._confidenceStore.recordEntityAccess(r.id);
            this._confidenceStore.adjustEntityConfidence(r.id, 0.01, 'usage_accumulation', 'kg_query');
          } else {
            this.db.prepare(`UPDATE entities SET access_count = COALESCE(access_count,0)+1, last_accessed = ? WHERE id = ?`).run(now, r.id);
          }
        }
      }
      return rows.map(this.parseEntity);
    }

    const sql = include_expired
      ? `SELECT * FROM entities ${staleFilter}`
      : `SELECT * FROM entities WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ? ${staleFilter}`;
    const params: (string | number)[] = include_expired ? [] : [as_of, as_of];
    const rows = (this.db.prepare(sql).all(...params) as Entity[]);
    return rows.map(this.parseEntity);
  }

  /**
   * Get entity by name and type.
   */
  getEntity(name: string, type: EntityType): Entity | null {
    const row = this.db.prepare(`
      SELECT * FROM entities WHERE name = ? AND type = ? AND valid_to IS NULL
    `).get(name, type) as Entity | undefined;
    if (!row) return null;
    const entity = this.parseEntity(row);
    if (this._confidenceStore) {
      this._confidenceStore.recordEntityAccess(entity.id);
      this._confidenceStore.adjustEntityConfidence(entity.id, 0.01, 'usage_accumulation', 'kg_query');
    } else {
      this.db.prepare(`UPDATE entities SET access_count = COALESCE(access_count,0)+1, last_accessed = ? WHERE id = ?`).run(Date.now(), entity.id);
    }
    return entity;
  }

  /**
   * Get an active entity by exact name, regardless of type.
   * If multiple exist, return the earliest created active one.
   */
  getEntityByName(name: string): Entity | null {
    const row = this.db.prepare(`
      SELECT * FROM entities WHERE lower(name) = lower(?) AND valid_to IS NULL ORDER BY created_at ASC LIMIT 1
    `).get(name) as Entity | undefined;
    return row ? this.parseEntity(row) : null;
  }

  /**
   * Invalidate an entity — marks it as no longer current.
   * Historical queries will still see it; current queries won't.
   */
  invalidateEntity(entityId: string, ended: number = Date.now()): void {
    this.db.prepare('UPDATE entities SET valid_to = ? WHERE id = ?').run(ended, entityId);
    this.db.prepare('UPDATE relations SET valid_to = ? WHERE subject_id = ? OR object_id = ?')
      .run(ended, entityId, entityId);
  }

  /**
   * Touch an entity — update last_accessed and increment access_count.
   * Call this when an entity is used in a query, reasoning, or answer.
   */
  touchEntity(entityId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE entities
      SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed = ?
      WHERE id = ?
    `).run(now, entityId);
  }

  /**
   * Touch a relation — update last_accessed and increment access_count.
   */
  touchRelation(relationId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE relations
      SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed = ?
      WHERE id = ?
    `).run(now, relationId);
  }

  /**
   * Update an entity's status (active → dormant → archived).
   */
  setEntityStatus(entityId: string, status: 'active' | 'dormant' | 'archived'): void {
    this.db.prepare(`UPDATE entities SET status = ? WHERE id = ?`).run(status, entityId);
  }

  /**
   * Update an entity's area (domain).
   */
  setEntityArea(entityId: string, area: string): void {
    this.db.prepare(`UPDATE entities SET area = ? WHERE id = ?`).run(area, entityId);
  }

  // ─── Confidence / Decay ─────────────────────────────────────────────────────

  /**
   * Run the confidence decay job on all stale entities.
   * Convenience wrapper around ConfidenceStore.applyDecay.
   */
  runDecay(options?: {
    staleness_threshold_days?: number;
    decay_per_period?: number;
    max_decay?: number;
  }): DecayReport | null {
    if (!this._confidenceStore) return null;
    return this._confidenceStore.applyDecay(options);
  }

  /**
   * Adjust an entity's confidence (e.g. user correction/confirmation).
   */
  adjustEntityConfidence(
    entityId: string,
    delta: number,
    reason: 'user_correction' | 'user_confirmation' | 'somatic_error' | 'somatic_confirm' | 'conflict_resolution' | 'usage_accumulation' | 'decay',
    source: 'user_feedback' | 'kg_inference' | 'agent_decision' | 'conflict_resolution' | 'decay_cron'
  ): ReturnType<ConfidenceStore['adjustEntityConfidence']> | null {
    if (!this._confidenceStore) return null;
    return this._confidenceStore.adjustEntityConfidence(entityId, delta, reason, source);
  }

  /**
   * Get confidence stats for the KG.
   */
  getConfidenceStats(): ReturnType<ConfidenceStore['stats']> | null {
    return this._confidenceStore?.stats() ?? null;
  }

  // ─── Relation Operations ────────────────────────────────────────────────────

  /**
   * Add a relation between two entities.
   * If a ConfidenceStore is wired, checks for conflicts and delegates confidence logging.
   */
  addRelation(
    subjectId: string,
    predicate: Predicate,
    objectId: string,
    confidence: number = 1.0,
    source: string | null = null
  ): { relation: Relation; conflict?: ReturnType<ConfidenceStore['checkConflict']> } {
    // Conflict check before committing
    let conflict: ReturnType<ConfidenceStore['checkConflict']> | undefined;
    if (this._confidenceStore) {
      conflict = this._confidenceStore.checkConflict(subjectId, predicate, objectId, confidence);
    }

    const id = uuidv4();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO relations (id, subject_id, predicate, object_id, valid_from, confidence, source, created_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
    `).run(id, subjectId, predicate, objectId, now, confidence, source, now);

    const relation = { id, subject_id: subjectId, predicate, object_id: objectId, valid_from: now, valid_to: null, confidence, source, created_at: now, last_accessed: null, access_count: 0 };

    return { relation, conflict };
  }

  /**
   * Query relations. Supports temporal filtering.
   */
  queryRelations(subjectId?: string, predicate?: Predicate, asOf: number = Date.now()): Relation[] {
    let sql = 'SELECT * FROM relations WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
    const params: (string | number)[] = [asOf, asOf];

    if (subjectId) {
      sql += ' AND subject_id = ?';
      params.push(subjectId);
    }
    if (predicate) {
      sql += ' AND predicate = ?';
      params.push(predicate);
    }

    return this.db.prepare(sql).all(...params) as Relation[];
  }

  /**
   * Get all relations where source matches a memory ID.
   * This is used to trace facts derived from a specific memory.
   */
  getRelationsBySource(sourceId: string): Relation[] {
    return this.db.prepare(`
      SELECT * FROM relations WHERE source = ?
    `).all(sourceId) as Relation[];
  }

  /**
   * Get all facts about an entity — both incoming and outgoing relations.
   */
  getEntityFacts(entityId: string, asOf: number = Date.now()): { outgoing: Relation[]; incoming: Relation[] } {
    const outgoing = this.db.prepare(`
      SELECT * FROM relations 
      WHERE subject_id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?
    `).all(entityId, asOf, asOf) as Relation[];

    const incoming = this.db.prepare(`
      SELECT * FROM relations 
      WHERE object_id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?
    `).all(entityId, asOf, asOf) as Relation[];

    return { outgoing, incoming };
  }

  // ─── Memory Operations ──────────────────────────────────────────────────────

  /**
   * Store a memory item, linked to an entry.
   */
  addMemory(
    entryId: string,
    content: string,
    memoryType: MemoryType,
    section: string,
    module: string,
    summary: string | null = null,
    importance: number = 0.5
  ): Memory {
    const id = uuidv4();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO memories (id, entry_id, content, summary, memory_type, section, module, importance, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(id, entryId, content, summary, memoryType, section, module, importance, now);

    return {
      id, entry_id: entryId, content, summary, memory_type: memoryType,
      section, module, importance, contradiction_flag: false, contradiction_with: null,
      status: 'active', valid_to: null,
      created_at: now, last_accessed: null, access_count: 0
    };
  }

  /**
   * Search memories using FTS5.
   * Falls back to LIKE query if FTS returns no results.
   */
  searchMemories(query: string, module?: string, section?: string, limit: number = 20): Memory[] {
    const q = (query ?? '').trim();
    if (!q) return [];

    // Try FTS5 first with named params
    try {
      let ftsSql = `
        SELECT m.* FROM memories m
        JOIN memories_fts ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH @q
      `;
      const ftsParams: Record<string, string | number> = {
        q,
        limit,
      };

      if (module) {
        ftsSql += ' AND m.module = @module';
        ftsParams['module'] = module;
      }
      if (section) {
        ftsSql += ' AND m.section = @section';
        ftsParams['section'] = section;
      }

      ftsSql += ' ORDER BY m.created_at DESC LIMIT @limit';

      const rows = this.db.prepare(ftsSql).all(ftsParams) as Memory[];
      if (rows.length > 0) {
        return rows.map(row => ({ ...row, contradiction_flag: (row as any).contradiction_flag === 1 }));
      }
    } catch {
      // FTS may fail for some queries, fall through to LIKE
    }

    // Fallback: LIKE query (full query + keyword terms) with lexical ranking
    try {
      const tokens = q
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 4)
        .slice(0, 8);

      const matchClauses: string[] = ['content LIKE @like'];
      const scoreClauses: string[] = ['CASE WHEN lower(content) LIKE lower(@like) THEN 100 ELSE 0 END'];
      const fallbackParams: Record<string, string | number> = {
        like: `%${q}%`,
        limit,
      };

      tokens.forEach((t, i) => {
        const key = `term${i}`;
        matchClauses.push(`content LIKE @${key}`);
        scoreClauses.push(`CASE WHEN lower(content) LIKE lower(@${key}) THEN 10 ELSE 0 END`);
        fallbackParams[key] = `%${t}%`;
      });

      let fallbackSql = `
        SELECT *, (${scoreClauses.join(' + ')}) AS lexical_score
        FROM memories
        WHERE (${matchClauses.join(' OR ')})
      `;

      if (module) {
        fallbackSql += ' AND module = @module';
        fallbackParams['module'] = module;
      }
      if (section) {
        fallbackSql += ' AND section = @section';
        fallbackParams['section'] = section;
      }

      fallbackSql += ' ORDER BY lexical_score DESC, created_at DESC LIMIT @limit';

      const rows = this.db.prepare(fallbackSql).all(fallbackParams) as (Memory & { lexical_score?: number })[];
      return rows.map(row => ({ ...row, contradiction_flag: (row as any).contradiction_flag === 1 }));
    } catch {
      return [];
    }
  }

  /**
   * Rebuild the FTS5 index from scratch.
   * Use when FTS is out of sync or returning no results.
   */
  rebuildFTSIndex(): void {
    this.db.exec(`
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    `);
  }

  /**
   * Get memories by module and section (structure navigation).
   */
  getMemoriesByStructure(module: string, section?: string, category?: CategoryType): Memory[] {
    let sql = `
      SELECT m.*
      FROM memories m
      LEFT JOIN entries e ON m.entry_id = e.entry_id
      LEFT JOIN drawers d ON m.entry_id = d.drawer_id
      WHERE m.module = ?
    `;
    const params: string[] = [module];

    if (section) {
      sql += ' AND m.section = ?';
      params.push(section);
    }
    if (category) {
      sql += ' AND (e.category = ? OR d.hall = ?)';
      params.push(category);
      params.push(category);
    }

    sql += ' ORDER BY m.created_at DESC';
    return (this.db.prepare(sql).all(...params) as Memory[]).map(row => ({ ...row, contradiction_flag: (row as any).contradiction_flag === 1 }));
  }

  /**
   * Legacy method: Get memories by wing and room (palace navigation).
   * Maps to new structure terminology.
   */
  getMemoriesByPalace(wing: string, room?: string, hall?: CategoryType): Memory[] {
    return this.getMemoriesByStructure(wing, room, hall);
  }

  /**
   * Mark a memory as contradictory.
   */
  flagContradiction(memoryId: string, conflictingMemoryId: string): void {
    this.db.prepare(`
      UPDATE memories SET contradiction_flag = 1, contradiction_with = ? WHERE id = ?
    `).run(conflictingMemoryId, memoryId);
  }

  /**
   * Clear a contradiction flag — marks the memory as resolved.
   */
  clearContradiction(memoryId: string): void {
    this.db.prepare(`
      UPDATE memories SET contradiction_flag = 0, contradiction_with = NULL WHERE id = ?
    `).run(memoryId);
  }

  /**
   * Record an access — updates last_accessed and increments access_count.
   */
  recordAccess(memoryId: string): void {
    this.db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?
    `).run(Date.now(), memoryId);
  }

  // ─── Entry Operations ──────────────────────────────────────────────────────

  /**
   * Register an entry (a file containing verbatim content).
   */
  addEntry(module: string, section: string, category: CategoryType, filePath: string, contentHash: string): Entry {
    const entryId = uuidv4();
    const now = Date.now();

    // Upsert — entry is uniquely identified by file_path
    this.db.prepare(`
      INSERT OR REPLACE INTO entries (entry_id, module, section, category, file_path, content_hash, created_at)
      VALUES (
        COALESCE((SELECT entry_id FROM entries WHERE file_path = ?), ?),
        ?, ?, ?, ?, ?, ?
      )
    `).run(filePath, entryId, module, section, category, filePath, contentHash, now);

    const row = this.db.prepare('SELECT * FROM entries WHERE file_path = ?').get(filePath) as Entry;
    return row;
  }

  /**
   * Legacy method: Register a drawer (maps to entry).
   */
  addDrawer(wing: string, room: string, hall: CategoryType, filePath: string, contentHash: string): Drawer {
    const drawerId = uuidv4();
    const now = Date.now();

    this.db.prepare(`
      INSERT OR REPLACE INTO drawers (drawer_id, wing, room, hall, file_path, content_hash, created_at)
      VALUES (
        COALESCE((SELECT drawer_id FROM drawers WHERE file_path = ?), ?),
        ?, ?, ?, ?, ?, ?
      )
    `).run(filePath, drawerId, wing, room, hall, filePath, contentHash, now);

    const row = this.db.prepare('SELECT * FROM drawers WHERE file_path = ?').get(filePath) as Drawer;
    return row;
  }

  /**
   * Get entry by path.
   */
  getEntry(filePath: string): Entry | null {
    return this.db.prepare('SELECT * FROM entries WHERE file_path = ?').get(filePath) as Entry | undefined ?? null;
  }

  /**
   * Get entry by ID.
   */
  getEntryById(entryId: string): Entry | null {
    return this.db.prepare('SELECT * FROM entries WHERE entry_id = ?').get(entryId) as Entry | undefined ?? null;
  }

  /**
   * Get memories by entry ID (for drawer invalidation).
   */
  getMemoriesByEntryId(entryId: string): Memory[] {
    return this.db.prepare(`
      SELECT * FROM memories WHERE entry_id = ? ORDER BY created_at DESC
    `).all(entryId) as Memory[];
  }

  /**
   * Legacy method: Get drawer by path.
   */
  getDrawer(filePath: string): Drawer | null {
    return this.db.prepare('SELECT * FROM drawers WHERE file_path = ?').get(filePath) as Drawer | undefined ?? null;
  }

  // ─── Timeline ──────────────────────────────────────────────────────────────

  /**
   * Get chronological story of an entity — all facts about it in time order.
   */
  timeline(entityId: string): { time: number; event: string; type: 'entity' | 'relation' }[] {
    const events: { time: number; event: string; type: 'entity' | 'relation' }[] = [];

    const entity = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as Entity;
    if (entity) {
      events.push({ time: entity.created_at, event: `${entity.name} created`, type: 'entity' });
      if (entity.valid_to) {
        events.push({ time: entity.valid_to, event: `${entity.name} invalidated`, type: 'entity' });
      }
    }

    const relations = this.db.prepare(`
      SELECT r.*, 
             s.name as subject_name, o.name as object_name
      FROM relations r
      JOIN entities s ON r.subject_id = s.id
      JOIN entities o ON r.object_id = o.id
      WHERE r.subject_id = ? OR r.object_id = ?
      ORDER BY r.valid_from ASC
    `).all(entityId, entityId) as (Relation & { subject_name: string; object_name: string })[];

    for (const rel of relations) {
      events.push({
        time: rel.valid_from,
        event: `${rel.subject_name} ${rel.predicate} ${rel.object_name}`,
        type: 'relation'
      });
      if (rel.valid_to) {
        events.push({
          time: rel.valid_to,
          event: `${rel.subject_name} ${rel.predicate} ended`,
          type: 'relation'
        });
      }
    }

    return events.sort((a, b) => a.time - b.time);
  }

  // ─── Statistics ─────────────────────────────────────────────────────────────

  stats(): KGStats {
    const entity_count = (this.db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    const active_entities = (this.db.prepare('SELECT COUNT(*) as c FROM entities WHERE valid_to IS NULL').get() as { c: number }).c;
    const relation_count = (this.db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c;
    const memory_count = (this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    const entry_count = (this.db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }).c;
    const contradictions = (this.db.prepare('SELECT COUNT(*) as c FROM memories WHERE contradiction_flag = 1').get() as { c: number }).c;

    return { entity_count, relation_count, memory_count, entry_count, active_entities, contradictions };
  }

  // ─── Helper ─────────────────────────────────────────────────────────────────

  private parseEntity(row: Entity): Entity {
    return {
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      // v0.3: Fill defaults for pre-migration entities
      confidence: (row as any).confidence ?? 1.0,
      last_accessed: (row as any).last_accessed ?? null,
      access_count: (row as any).access_count ?? 0,
      status: (row as any).status ?? 'active',
      area: (row as any).area ?? null,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Export entire KG as JSON (for backup/migration).
   */
  export(): { entities: Entity[]; relations: Relation[]; memories: Memory[]; entries: Entry[]; drawers: Drawer[] } {
    return {
      entities: this.db.prepare('SELECT * FROM entities').all() as Entity[],
      relations: this.db.prepare('SELECT * FROM relations').all() as Relation[],
      memories: this.db.prepare('SELECT * FROM memories').all() as Memory[],
      entries: this.db.prepare('SELECT * FROM entries').all() as Entry[],
      drawers: this.db.prepare('SELECT * FROM drawers').all() as Drawer[],
    };
  }

  /**
   * Import KG from JSON (for restore/migration).
   */
  import(data: { entities: Entity[]; relations: Relation[]; memories: Memory[]; entries?: Entry[]; drawers?: Drawer[] }): void {
    const insertEntity = this.db.prepare(`
      INSERT OR REPLACE INTO entities (id, name, type, created_at, valid_from, valid_to, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRelation = this.db.prepare(`
      INSERT OR REPLACE INTO relations (id, subject_id, predicate, object_id, valid_from, valid_to, confidence, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMemory = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, entry_id, content, summary, memory_type, section, module, importance, contradiction_flag, contradiction_with, created_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEntry = this.db.prepare(`
      INSERT OR REPLACE INTO entries (entry_id, module, section, category, file_path, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDrawer = this.db.prepare(`
      INSERT OR REPLACE INTO drawers (drawer_id, wing, room, hall, file_path, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const e of data.entities) {
        insertEntity.run(e.id, e.name, e.type, e.created_at, e.valid_from, e.valid_to, JSON.stringify(e.metadata));
      }
      for (const r of data.relations) {
        insertRelation.run(r.id, r.subject_id, r.predicate, r.object_id, r.valid_from, r.valid_to, r.confidence, r.source, r.created_at);
      }
      for (const m of data.memories) {
        insertMemory.run(m.id, m.entry_id, m.content, m.summary, m.memory_type, m.section, m.module, m.importance, m.contradiction_flag ? 1 : 0, m.contradiction_with, m.created_at, m.last_accessed, m.access_count);
      }
      if (data.entries) {
        for (const e of data.entries) {
          insertEntry.run(e.entry_id, e.module, e.section, e.category, e.file_path, e.content_hash, e.created_at);
        }
      }
      if (data.drawers) {
        for (const d of data.drawers) {
          insertDrawer.run(d.drawer_id, d.wing, d.room, d.hall, d.file_path, d.content_hash, d.created_at);
        }
      }
    });

    txn();
  }

  /**
   * Update memory salience score.
   */
  updateMemorySalience(memoryId: string, salience: number): void {
    this.db.prepare(`
      UPDATE memories SET importance = ? WHERE id = ?
    `).run(salience, memoryId);
  }

  /**
   * Update memory access count and last_accessed.
   */
  touchMemory(memoryId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE memories 
      SET access_count = COALESCE(access_count, 0) + 1, 
          last_accessed = ? 
      WHERE id = ?
    `).run(now, memoryId);
  }

  /**
   * Invalidate a memory — mark it as no longer current.
   * Separate from contradiction (which marks an actual conflict).
   */
  invalidateMemory(memoryId: string, reason: 'user_deleted' | 'expired' | 'superseded' | 'error', ended: number = Date.now()): void {
    this.db.prepare(`
      UPDATE memories 
      SET status = 'invalidated', 
          valid_to = ?,
          summary = COALESCE(summary, '') || ' [invalidated: ' || ? || ']'
      WHERE id = ?
    `).run(ended, reason, memoryId);
  }

  /**
   * Get a memory by ID.
   */
  getMemoryById(memoryId: string): Memory | null {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as Memory | undefined ?? null;
  }

  /**
   * Get recent memories across all wings/rooms.
   */
  getRecentMemories(limit: number = 10): Memory[] {
    return this.db.prepare(`
      SELECT * FROM memories ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Memory[];
  }

  /**
   * Get memories by status (for compaction, cleanup).
   */
  getMemoriesByStatus(status: Memory['status'], limit: number = 1000): Memory[] {
    return this.db.prepare(`
      SELECT * FROM memories WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `).all(status, limit) as Memory[];
  }
}
