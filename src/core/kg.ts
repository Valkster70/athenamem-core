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

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const EntityTypeSchema = z.enum([
  'person', 'project', 'topic', 'decision', 'lesson', 'event', 'preference', 'agent'
]);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const PredicateSchema = z.enum([
  'works_on', 'decided', 'prefers', 'learned', 'assigned_to', 'completed',
  'conflicts_with', 'related_to', 'created', 'updated', 'failed', 'succeeded',
  'recommended', 'rejected', 'mentioned', 'owns', 'depends_on'
]);
export type Predicate = z.infer<typeof PredicateSchema>;

export const MemoryTypeSchema = z.enum([
  'conversation', 'decision', 'lesson', 'event', 'preference', 'fact', 'discovery', 'advice'
]);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const CategoryTypeSchema = z.enum([
  'facts', 'events', 'discoveries', 'preferences', 'advice'
]);
export type CategoryType = z.infer<typeof CategoryTypeSchema>;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  created_at: number;
  valid_from: number;
  valid_to: number | null;  // null = still active
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
  source: string | null;  // entry_id
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
  as_of?: number;  // unix timestamp, defaults to now
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

// ─── KnowledgeGraph Class ─────────────────────────────────────────────────────

export class KnowledgeGraph {
  private db: Database.Database;
  private _dbPath: string;

  constructor(dbPath: string) {
    this._dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      -- Entities: people, projects, topics, decisions, lessons, etc.
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'person','project','topic','decision','lesson','event','preference','agent'
        )),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_to INTEGER,
        metadata JSON DEFAULT '{}'
      );

      -- Relations between entities
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES entities(id),
        predicate TEXT NOT NULL CHECK (predicate IN (
          'works_on','decided','prefers','learned','assigned_to','completed',
          'conflicts_with','related_to','created','updated','failed','succeeded',
          'recommended','rejected','mentioned','owns','depends_on'
        )),
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
        contradiction_flag INTEGER NOT NULL DEFAULT 0,
        contradiction_with TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_entries_module ON entries(module);
      CREATE INDEX IF NOT EXISTS idx_drawers_wing ON drawers(wing);
    `);
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
      INSERT INTO entities (id, name, type, created_at, valid_from, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, type, now, now, meta);

    return { id, name, type, created_at: now, valid_from: now, valid_to: null, metadata };
  }

  /**
   * Query entities. Supports temporal filtering via `as_of`.
   * If as_of is set, only returns entities that were valid at that time.
   */
  queryEntities(query: TemporalQuery = {}): Entity[] {
    const { entity_id, as_of = Date.now(), include_expired = false } = query;

    if (entity_id) {
      const sql = include_expired
        ? 'SELECT * FROM entities WHERE id = ?'
        : 'SELECT * FROM entities WHERE id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
      const row = this.db.prepare(sql).get(entity_id, as_of, as_of) as Entity | undefined;
      return row ? [this.parseEntity(row)] : [];
    }

    const sql = include_expired
      ? 'SELECT * FROM entities'
      : 'SELECT * FROM entities WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
    
    return (this.db.prepare(sql).all(as_of, as_of) as Entity[]).map(this.parseEntity);
  }

  /**
   * Get entity by name and type.
   */
  getEntity(name: string, type: EntityType): Entity | null {
    const row = this.db.prepare(`
      SELECT * FROM entities WHERE name = ? AND type = ? AND valid_to IS NULL
    `).get(name, type) as Entity | undefined;
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

  // ─── Relation Operations ────────────────────────────────────────────────────

  /**
   * Add a relation between two entities.
   */
  addRelation(
    subjectId: string,
    predicate: Predicate,
    objectId: string,
    confidence: number = 1.0,
    source: string | null = null
  ): Relation {
    const id = uuidv4();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO relations (id, subject_id, predicate, object_id, valid_from, confidence, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, subjectId, predicate, objectId, now, confidence, source, now);

    return { id, subject_id: subjectId, predicate, object_id: objectId, valid_from: now, valid_to: null, confidence, source, created_at: now };
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
      INSERT INTO memories (id, entry_id, content, summary, memory_type, section, module, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, entryId, content, summary, memoryType, section, module, importance, now);

    return {
      id, entry_id: entryId, content, summary, memory_type: memoryType,
      section, module, importance, contradiction_flag: false, contradiction_with: null,
      created_at: now, last_accessed: null, access_count: 0
    };
  }

  /**
   * Search memories using FTS5.
   * Falls back to LIKE query if FTS returns no results.
   */
  searchMemories(query: string, module?: string, section?: string, limit: number = 20): Memory[] {
    // Try FTS5 first
    let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
    `;
    const params: (string | number)[] = [query];

    if (module) {
      sql += ' AND m.module = ?';
      params.push(module);
    }
    if (section) {
      sql += ' AND m.section = ?';
      params.push(section);
    }

    sql += ' ORDER BY rank LIMIT ?';
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Memory[];
      if (rows.length > 0) {
        return rows.map(row => ({ ...row, contradiction_flag: (row as any).contradiction_flag === 1 }));
      }
    } catch (e) {
      // FTS might fail on some queries, fall through to LIKE
    }

    // Fallback: LIKE query for broader matching
    let fallbackSql = `SELECT * FROM memories WHERE content LIKE ?`;
    const fallbackParams: (string | number)[] = [`%${query}%`];

    if (module) {
      fallbackSql += ' AND module = ?';
      fallbackParams.push(module);
    }
    if (section) {
      fallbackSql += ' AND section = ?';
      fallbackParams.push(section);
    }

    fallbackSql += ' ORDER BY created_at DESC LIMIT ?';
    fallbackParams.push(limit);

    const rows = this.db.prepare(fallbackSql).all(...fallbackParams) as Memory[];
    return rows.map(row => ({ ...row, contradiction_flag: (row as any).contradiction_flag === 1 }));
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
    let sql = 'SELECT m.* FROM memories m JOIN entries e ON m.entry_id = e.entry_id WHERE m.module = ?';
    const params: string[] = [module];

    if (section) {
      sql += ' AND m.section = ?';
      params.push(section);
    }
    if (category) {
      sql += ' AND e.category = ?';
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
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
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
}
