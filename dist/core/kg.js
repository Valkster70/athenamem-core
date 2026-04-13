/**
 * AthenaMem Knowledge Graph
 *
 * Temporal entity-relation graph with validity windows.
 * Inspired by MemPalace's KG + Hindsight's biomimetic structure.
 *
 * Entities have validity windows — queries can ask "what was true at time X?"
 * Every fact is traceable to a source drawer.
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
export const PredicateSchema = z.enum([
    'works_on', 'decided', 'prefers', 'learned', 'assigned_to', 'completed',
    'conflicts_with', 'related_to', 'created', 'updated', 'failed', 'succeeded',
    'recommended', 'rejected', 'mentioned', 'owns', 'depends_on'
]);
export const MemoryTypeSchema = z.enum([
    'conversation', 'decision', 'lesson', 'event', 'preference', 'fact', 'discovery', 'advice'
]);
export const HallTypeSchema = z.enum([
    'facts', 'events', 'discoveries', 'preferences', 'advice'
]);
// ─── KnowledgeGraph Class ─────────────────────────────────────────────────────
export class KnowledgeGraph {
    db;
    _dbPath;
    constructor(dbPath) {
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
    init() {
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
        drawer_id TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        memory_type TEXT NOT NULL CHECK (memory_type IN (
          'conversation','decision','lesson','event','preference','fact','discovery','advice'
        )),
        room TEXT NOT NULL,
        wing TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        contradiction_flag INTEGER NOT NULL DEFAULT 0,
        contradiction_with TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        last_accessed INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      -- Drawers (verbatim storage)
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
      CREATE INDEX IF NOT EXISTS idx_memories_wing_room ON memories(wing, room);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_contradiction ON memories(contradiction_flag) WHERE contradiction_flag = 1;
      CREATE INDEX IF NOT EXISTS idx_drawers_wing ON drawers(wing);
    `);
    }
    // ─── Entity Operations ──────────────────────────────────────────────────────
    /**
     * Add a new entity. If one with the same name+type already exists and is active,
     * returns the existing entity instead of creating a duplicate.
     */
    addEntity(name, type, metadata = {}) {
        const existing = this.db.prepare(`
      SELECT * FROM entities WHERE name = ? AND type = ? AND valid_to IS NULL
    `).get(name, type);
        if (existing)
            return existing;
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
    queryEntities(query = {}) {
        const { entity_id, as_of = Date.now(), include_expired = false } = query;
        if (entity_id) {
            const sql = include_expired
                ? 'SELECT * FROM entities WHERE id = ?'
                : 'SELECT * FROM entities WHERE id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
            return this.db.prepare(sql).all(entity_id, as_of, as_of).map(this.parseEntity);
        }
        const sql = include_expired
            ? 'SELECT * FROM entities'
            : 'SELECT * FROM entities WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
        return this.db.prepare(sql).all(as_of, as_of).map(this.parseEntity);
    }
    /**
     * Get entity by name and type.
     */
    getEntity(name, type) {
        const row = this.db.prepare(`
      SELECT * FROM entities WHERE name = ? AND type = ? AND valid_to IS NULL
    `).get(name, type);
        return row ? this.parseEntity(row) : null;
    }
    /**
     * Invalidate an entity — marks it as no longer current.
     * Historical queries will still see it; current queries won't.
     */
    invalidateEntity(entityId, ended = Date.now()) {
        this.db.prepare('UPDATE entities SET valid_to = ? WHERE id = ?').run(ended, entityId);
        this.db.prepare('UPDATE relations SET valid_to = ? WHERE subject_id = ? OR object_id = ?')
            .run(ended, entityId, entityId);
    }
    // ─── Relation Operations ────────────────────────────────────────────────────
    /**
     * Add a relation between two entities.
     */
    addRelation(subjectId, predicate, objectId, confidence = 1.0, source = null) {
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
    queryRelations(subjectId, predicate, asOf = Date.now()) {
        let sql = 'SELECT * FROM relations WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
        const params = [asOf, asOf];
        if (subjectId) {
            sql += ' AND subject_id = ?';
            params.push(subjectId);
        }
        if (predicate) {
            sql += ' AND predicate = ?';
            params.push(predicate);
        }
        return this.db.prepare(sql).all(...params);
    }
    /**
     * Get all facts about an entity — both incoming and outgoing relations.
     */
    getEntityFacts(entityId, asOf = Date.now()) {
        const outgoing = this.db.prepare(`
      SELECT * FROM relations 
      WHERE subject_id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?
    `).all(entityId, asOf, asOf);
        const incoming = this.db.prepare(`
      SELECT * FROM relations 
      WHERE object_id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?
    `).all(entityId, asOf, asOf);
        return { outgoing, incoming };
    }
    // ─── Memory Operations ──────────────────────────────────────────────────────
    /**
     * Store a memory item, linked to a drawer.
     */
    addMemory(drawerId, content, memoryType, room, wing, summary = null, importance = 0.5) {
        const id = uuidv4();
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO memories (id, drawer_id, content, summary, memory_type, room, wing, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, drawerId, content, summary, memoryType, room, wing, importance, now);
        return {
            id, drawer_id: drawerId, content, summary, memory_type: memoryType,
            room, wing, importance, contradiction_flag: false, contradiction_with: null,
            created_at: now, last_accessed: null, access_count: 0
        };
    }
    /**
     * Search memories using FTS5.
     */
    searchMemories(query, wing, room, limit = 20) {
        let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts fts ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
    `;
        const params = [query];
        if (wing) {
            sql += ' AND m.wing = ?';
            params.push(wing);
        }
        if (room) {
            sql += ' AND m.room = ?';
            params.push(room);
        }
        sql += ' ORDER BY rank LIMIT ?';
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(row => ({ ...row, contradiction_flag: row.contradiction_flag === 1 }));
    }
    /**
     * Get memories by wing and room (palace navigation).
     */
    getMemoriesByPalace(wing, room, hall) {
        let sql = 'SELECT m.* FROM memories m JOIN drawers d ON m.drawer_id = d.drawer_id WHERE m.wing = ?';
        const params = [wing];
        if (room) {
            sql += ' AND m.room = ?';
            params.push(room);
        }
        if (hall) {
            sql += ' AND d.hall = ?';
            params.push(hall);
        }
        sql += ' ORDER BY m.created_at DESC';
        return this.db.prepare(sql).all(...params).map(row => ({ ...row, contradiction_flag: row.contradiction_flag === 1 }));
    }
    /**
     * Mark a memory as contradictory.
     */
    flagContradiction(memoryId, conflictingMemoryId) {
        this.db.prepare(`
      UPDATE memories SET contradiction_flag = 1, contradiction_with = ? WHERE id = ?
    `).run(conflictingMemoryId, memoryId);
    }
    /**
     * Record an access — updates last_accessed and increments access_count.
     */
    recordAccess(memoryId) {
        this.db.prepare(`
      UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?
    `).run(Date.now(), memoryId);
    }
    // ─── Drawer Operations ──────────────────────────────────────────────────────
    /**
     * Register a drawer (a file containing verbatim content).
     */
    addDrawer(wing, room, hall, filePath, contentHash) {
        const drawerId = uuidv4();
        const now = Date.now();
        // Upsert — drawer is uniquely identified by file_path
        this.db.prepare(`
      INSERT OR REPLACE INTO drawers (drawer_id, wing, room, hall, file_path, content_hash, created_at)
      VALUES (
        COALESCE((SELECT drawer_id FROM drawers WHERE file_path = ?), ?),
        ?, ?, ?, ?, ?, ?
      )
    `).run(filePath, drawerId, wing, room, hall, filePath, contentHash, now);
        const row = this.db.prepare('SELECT * FROM drawers WHERE file_path = ?').get(filePath);
        return row;
    }
    /**
     * Get drawer by path.
     */
    getDrawer(filePath) {
        return this.db.prepare('SELECT * FROM drawers WHERE file_path = ?').get(filePath) ?? null;
    }
    // ─── Timeline ──────────────────────────────────────────────────────────────
    /**
     * Get chronological story of an entity — all facts about it in time order.
     */
    timeline(entityId) {
        const events = [];
        const entity = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);
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
    `).all(entityId, entityId);
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
    stats() {
        const entity_count = this.db.prepare('SELECT COUNT(*) as c FROM entities').get().c;
        const active_entities = this.db.prepare('SELECT COUNT(*) as c FROM entities WHERE valid_to IS NULL').get().c;
        const relation_count = this.db.prepare('SELECT COUNT(*) as c FROM relations').get().c;
        const memory_count = this.db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
        const drawer_count = this.db.prepare('SELECT COUNT(*) as c FROM drawers').get().c;
        const contradictions = this.db.prepare('SELECT COUNT(*) as c FROM memories WHERE contradiction_flag = 1').get().c;
        return { entity_count, relation_count, memory_count, drawer_count, active_entities, contradictions };
    }
    // ─── Helper ─────────────────────────────────────────────────────────────────
    parseEntity(row) {
        return {
            ...row,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        };
    }
    /**
     * Close the database connection.
     */
    close() {
        this.db.close();
    }
    /**
     * Export entire KG as JSON (for backup/migration).
     */
    export() {
        return {
            entities: this.db.prepare('SELECT * FROM entities').all(),
            relations: this.db.prepare('SELECT * FROM relations').all(),
            memories: this.db.prepare('SELECT * FROM memories').all(),
            drawers: this.db.prepare('SELECT * FROM drawers').all(),
        };
    }
    /**
     * Import KG from JSON (for restore/migration).
     */
    import(data) {
        const insertEntity = this.db.prepare(`
      INSERT OR REPLACE INTO entities (id, name, type, created_at, valid_from, valid_to, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        const insertRelation = this.db.prepare(`
      INSERT OR REPLACE INTO relations (id, subject_id, predicate, object_id, valid_from, valid_to, confidence, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const insertMemory = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, drawer_id, content, summary, memory_type, room, wing, importance, contradiction_flag, contradiction_with, created_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                insertMemory.run(m.id, m.drawer_id, m.content, m.summary, m.memory_type, m.room, m.wing, m.importance, m.contradiction_flag ? 1 : 0, m.contradiction_with, m.created_at, m.last_accessed, m.access_count);
            }
            for (const d of data.drawers) {
                insertDrawer.run(d.drawer_id, d.wing, d.room, d.hall, d.file_path, d.content_hash, d.created_at);
            }
        });
        txn();
    }
}
//# sourceMappingURL=kg.js.map