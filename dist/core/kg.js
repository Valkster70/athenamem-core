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
export const PredicateSchema = z.enum([
    'works_on', 'decided', 'prefers', 'learned', 'assigned_to', 'completed',
    'conflicts_with', 'related_to', 'created', 'updated', 'failed', 'succeeded',
    'recommended', 'rejected', 'mentioned', 'owns', 'depends_on'
]);
export const MemoryTypeSchema = z.enum([
    'conversation', 'decision', 'lesson', 'event', 'preference', 'fact', 'discovery', 'advice'
]);
export const CategoryTypeSchema = z.enum([
    'facts', 'events', 'discoveries', 'preferences', 'advice'
]);
// ─── KnowledgeGraph Class ─────────────────────────────────────────────────────
export class KnowledgeGraph {
    db;
    _dbPath;
    _confidenceStore = null;
    constructor(dbPath, confidenceStore) {
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
    setConfidenceStore(store) {
        this._confidenceStore = store;
    }
    get confidence() {
        return this._confidenceStore;
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
    migrate() {
        const memoryColumns = this.db.prepare(`PRAGMA table_info(memories)`).all();
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
        const entityColumns = this.db.prepare(`PRAGMA table_info(entities)`).all();
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
        const relColumns = this.db.prepare(`PRAGMA table_info(relations)`).all();
        const relColNames = new Set(relColumns.map((col) => col.name));
        if (!relColNames.has('last_accessed')) {
            this.db.exec(`ALTER TABLE relations ADD COLUMN last_accessed INTEGER;`);
        }
        if (!relColNames.has('access_count')) {
            this.db.exec(`ALTER TABLE relations ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;`);
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence) WHERE confidence < 1.0;`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status) WHERE status != 'active';`);
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
      INSERT INTO entities (id, name, type, created_at, valid_from, metadata, confidence, last_accessed, access_count, status)
      VALUES (?, ?, ?, ?, ?, ?, 1.0, NULL, 0, 'active')
    `).run(id, name, type, now, now, meta);
        return { id, name, type, created_at: now, valid_from: now, valid_to: null, metadata, confidence: 1.0, last_accessed: null, access_count: 0, status: 'active', area: null };
    }
    /**
     * Query entities. Supports temporal filtering via `as_of`.
     * If as_of is set, only returns entities that were valid at that time.
     */
    queryEntities(query = {}) {
        const { entity_id, entity_name, as_of = Date.now(), include_expired = false, include_stale = false } = query;
        if (entity_id) {
            const sql = include_expired
                ? 'SELECT * FROM entities WHERE id = ?'
                : 'SELECT * FROM entities WHERE id = ? AND (valid_to IS NULL OR valid_to > ?) AND valid_from <= ?';
            const params = include_expired ? [entity_id] : [entity_id, as_of, as_of];
            const row = this.db.prepare(sql).get(...params);
            if (!row)
                return [];
            const entity = this.parseEntity(row);
            // Track access on returned entity
            if (!include_stale) {
                if (this._confidenceStore) {
                    this._confidenceStore.recordEntityAccess(entity.id);
                    this._confidenceStore.adjustEntityConfidence(entity.id, 0.01, 'usage_accumulation', 'kg_query');
                }
                else {
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
            const params = include_expired ? [entity_name] : [entity_name, as_of, as_of];
            const rows = this.db.prepare(sql).all(...params);
            if (!include_stale && rows.length > 0) {
                const now = Date.now();
                for (const r of rows) {
                    if (this._confidenceStore) {
                        this._confidenceStore.recordEntityAccess(r.id);
                        this._confidenceStore.adjustEntityConfidence(r.id, 0.01, 'usage_accumulation', 'kg_query');
                    }
                    else {
                        this.db.prepare(`UPDATE entities SET access_count = COALESCE(access_count,0)+1, last_accessed = ? WHERE id = ?`).run(now, r.id);
                    }
                }
            }
            return rows.map(this.parseEntity);
        }
        const sql = include_expired
            ? `SELECT * FROM entities ${staleFilter}`
            : `SELECT * FROM entities WHERE (valid_to IS NULL OR valid_to > ?) AND valid_from <= ? ${staleFilter}`;
        const params = include_expired ? [] : [as_of, as_of];
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(this.parseEntity);
    }
    /**
     * Get entity by name and type.
     */
    getEntity(name, type) {
        const row = this.db.prepare(`
      SELECT * FROM entities WHERE name = ? AND type = ? AND valid_to IS NULL
    `).get(name, type);
        if (!row)
            return null;
        const entity = this.parseEntity(row);
        if (this._confidenceStore) {
            this._confidenceStore.recordEntityAccess(entity.id);
            this._confidenceStore.adjustEntityConfidence(entity.id, 0.01, 'usage_accumulation', 'kg_query');
        }
        else {
            this.db.prepare(`UPDATE entities SET access_count = COALESCE(access_count,0)+1, last_accessed = ? WHERE id = ?`).run(Date.now(), entity.id);
        }
        return entity;
    }
    /**
     * Get an active entity by exact name, regardless of type.
     * If multiple exist, return the earliest created active one.
     */
    getEntityByName(name) {
        const row = this.db.prepare(`
      SELECT * FROM entities WHERE lower(name) = lower(?) AND valid_to IS NULL ORDER BY created_at ASC LIMIT 1
    `).get(name);
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
    /**
     * Touch an entity — update last_accessed and increment access_count.
     * Call this when an entity is used in a query, reasoning, or answer.
     */
    touchEntity(entityId) {
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
    touchRelation(relationId) {
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
    setEntityStatus(entityId, status) {
        this.db.prepare(`UPDATE entities SET status = ? WHERE id = ?`).run(status, entityId);
    }
    /**
     * Update an entity's area (domain).
     */
    setEntityArea(entityId, area) {
        this.db.prepare(`UPDATE entities SET area = ? WHERE id = ?`).run(area, entityId);
    }
    // ─── Confidence / Decay ─────────────────────────────────────────────────────
    /**
     * Run the confidence decay job on all stale entities.
     * Convenience wrapper around ConfidenceStore.applyDecay.
     */
    runDecay(options) {
        if (!this._confidenceStore)
            return null;
        return this._confidenceStore.applyDecay(options);
    }
    /**
     * Adjust an entity's confidence (e.g. user correction/confirmation).
     */
    adjustEntityConfidence(entityId, delta, reason, source) {
        if (!this._confidenceStore)
            return null;
        return this._confidenceStore.adjustEntityConfidence(entityId, delta, reason, source);
    }
    /**
     * Get confidence stats for the KG.
     */
    getConfidenceStats() {
        return this._confidenceStore?.stats() ?? null;
    }
    // ─── Relation Operations ────────────────────────────────────────────────────
    /**
     * Add a relation between two entities.
     * If a ConfidenceStore is wired, checks for conflicts and delegates confidence logging.
     */
    addRelation(subjectId, predicate, objectId, confidence = 1.0, source = null) {
        // Conflict check before committing
        let conflict;
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
     * Get all relations where source matches a memory ID.
     * This is used to trace facts derived from a specific memory.
     */
    getRelationsBySource(sourceId) {
        return this.db.prepare(`
      SELECT * FROM relations WHERE source = ?
    `).all(sourceId);
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
     * Store a memory item, linked to an entry.
     */
    addMemory(entryId, content, memoryType, section, module, summary = null, importance = 0.5) {
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
    searchMemories(query, module, section, limit = 20) {
        const q = (query ?? '').trim();
        if (!q)
            return [];
        // Try FTS5 first with named params
        try {
            let ftsSql = `
        SELECT m.* FROM memories m
        JOIN memories_fts ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH @q
      `;
            const ftsParams = {
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
            const rows = this.db.prepare(ftsSql).all(ftsParams);
            if (rows.length > 0) {
                return rows.map(row => ({ ...row, contradiction_flag: row.contradiction_flag === 1 }));
            }
        }
        catch {
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
            const matchClauses = ['content LIKE @like'];
            const scoreClauses = ['CASE WHEN lower(content) LIKE lower(@like) THEN 100 ELSE 0 END'];
            const fallbackParams = {
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
            const rows = this.db.prepare(fallbackSql).all(fallbackParams);
            return rows.map(row => ({ ...row, contradiction_flag: row.contradiction_flag === 1 }));
        }
        catch {
            return [];
        }
    }
    /**
     * Rebuild the FTS5 index from scratch.
     * Use when FTS is out of sync or returning no results.
     */
    rebuildFTSIndex() {
        this.db.exec(`
      INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
    `);
    }
    /**
     * Get memories by module and section (structure navigation).
     */
    getMemoriesByStructure(module, section, category) {
        let sql = `
      SELECT m.*
      FROM memories m
      LEFT JOIN entries e ON m.entry_id = e.entry_id
      LEFT JOIN drawers d ON m.entry_id = d.drawer_id
      WHERE m.module = ?
    `;
        const params = [module];
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
        return this.db.prepare(sql).all(...params).map(row => ({ ...row, contradiction_flag: row.contradiction_flag === 1 }));
    }
    /**
     * Legacy method: Get memories by wing and room (palace navigation).
     * Maps to new structure terminology.
     */
    getMemoriesByPalace(wing, room, hall) {
        return this.getMemoriesByStructure(wing, room, hall);
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
    // ─── Entry Operations ──────────────────────────────────────────────────────
    /**
     * Register an entry (a file containing verbatim content).
     */
    addEntry(module, section, category, filePath, contentHash) {
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
        const row = this.db.prepare('SELECT * FROM entries WHERE file_path = ?').get(filePath);
        return row;
    }
    /**
     * Legacy method: Register a drawer (maps to entry).
     */
    addDrawer(wing, room, hall, filePath, contentHash) {
        const drawerId = uuidv4();
        const now = Date.now();
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
     * Get entry by path.
     */
    getEntry(filePath) {
        return this.db.prepare('SELECT * FROM entries WHERE file_path = ?').get(filePath) ?? null;
    }
    /**
     * Get entry by ID.
     */
    getEntryById(entryId) {
        return this.db.prepare('SELECT * FROM entries WHERE entry_id = ?').get(entryId) ?? null;
    }
    /**
     * Get memories by entry ID (for drawer invalidation).
     */
    getMemoriesByEntryId(entryId) {
        return this.db.prepare(`
      SELECT * FROM memories WHERE entry_id = ? ORDER BY created_at DESC
    `).all(entryId);
    }
    /**
     * Legacy method: Get drawer by path.
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
        const entry_count = this.db.prepare('SELECT COUNT(*) as c FROM entries').get().c;
        const contradictions = this.db.prepare('SELECT COUNT(*) as c FROM memories WHERE contradiction_flag = 1').get().c;
        return { entity_count, relation_count, memory_count, entry_count, active_entities, contradictions };
    }
    // ─── Helper ─────────────────────────────────────────────────────────────────
    parseEntity(row) {
        return {
            ...row,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
            // v0.3: Fill defaults for pre-migration entities
            confidence: row.confidence ?? 1.0,
            last_accessed: row.last_accessed ?? null,
            access_count: row.access_count ?? 0,
            status: row.status ?? 'active',
            area: row.area ?? null,
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
            entries: this.db.prepare('SELECT * FROM entries').all(),
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
    updateMemorySalience(memoryId, salience) {
        this.db.prepare(`
      UPDATE memories SET importance = ? WHERE id = ?
    `).run(salience, memoryId);
    }
    /**
     * Update memory access count and last_accessed.
     */
    touchMemory(memoryId) {
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
    invalidateMemory(memoryId, reason, ended = Date.now()) {
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
    getMemoryById(memoryId) {
        return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) ?? null;
    }
    /**
     * Get recent memories across all wings/rooms.
     */
    getRecentMemories(limit = 10) {
        return this.db.prepare(`
      SELECT * FROM memories ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    }
    /**
     * Get memories by status (for compaction, cleanup).
     */
    getMemoriesByStatus(status, limit = 1000) {
        return this.db.prepare(`
      SELECT * FROM memories WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `).all(status, limit);
    }
}
//# sourceMappingURL=kg.js.map