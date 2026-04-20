/**
 * AthenaMem Confidence System
 * 
 * Confidence-weighted knowledge graph with decay and conflict surfacing.
 * Inspired by NEXO Brain's trust scoring, adapted for structured KG semantics.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfidenceStatus = 'active' | 'dormant' | 'archived';

export interface ConfidenceDelta {
  entity_id?: string;
  relation_id?: string;
  delta: number;
  reason: ConfidenceReason;
  source: ConfidenceSource;
  created_at: number;
}

export type ConfidenceReason =
  | 'user_correction'
  | 'user_confirmation'
  | 'decay'
  | 'somatic_error'
  | 'somatic_confirm'
  | 'usage_accumulation'
  | 'conflict_resolution';

export type ConfidenceSource =
  | 'user_feedback'
  | 'decay_cron'
  | 'kg_inference'
  | 'kg_query'
  | 'agent_decision'
  | 'conflict_resolution';

export interface SomaticEvent {
  area: string;
  event_type: 'error' | 'correction' | 'confirm';
  delta: number;
  context?: string;
  created_at: number;
}

export interface DecayReport {
  entities_processed: number;
  entities_affected: number;
  entities_dormant: number;
  entities_skipped: number;
  relations_affected: number;
  details: { entity_id: string; name: string; old_conf: number; new_conf: number; reason: string }[];
}

export interface ConflictReport {
  entity_id: string;
  entity_name: string;
  existing_predicate: string;
  existing_value: string;
  existing_confidence: number;
  new_value: string;
  severity: 'high' | 'medium' | 'low';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DORMANCY_THRESHOLD = 0.0;
const DEFAULT_DECAY_INTERVAL_DAYS = 30;
const DEFAULT_DECAY_AMOUNT = 0.1;
const DEFAULT_MAX_DECAY = 0.5;

const AREA_DEFAULTS: Record<string, number> = {
  health: 1.0,
  project: 1.0,
  system: 1.0,
  preference: 1.0,
  person: 1.0,
  topic: 1.0,
  decision: 1.0,
  event: 1.0,
  lesson: 1.0,
  agent: 1.0,
};

// ─── ConfidenceStore Class ────────────────────────────────────────────────────

export class ConfidenceStore {
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
    this.init();
  }

  private init(): void {
    this.db.exec(`
      -- Confidence log: tracks all confidence changes
      CREATE TABLE IF NOT EXISTS confidence_log (
        id TEXT PRIMARY KEY,
        entity_id TEXT REFERENCES entities(id),
        relation_id TEXT REFERENCES relations(id),
        delta REAL NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Somatic events: area-level error tracking
      CREATE TABLE IF NOT EXISTS somatic_events (
        id TEXT PRIMARY KEY,
        area TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('error', 'correction', 'confirm')),
        delta REAL NOT NULL,
        context TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Entity-level confidence fields (extends entities table)
      -- Already added via migration in kg.ts
    `);
    this.migrate();
  }

  private migrate(): void {
    // Add confidence columns to entities if not present
    const entityCols = this.db.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>;
    const entityColNames = new Set(entityCols.map(c => c.name));

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

    // Add confidence columns to relations if not present
    const relCols = this.db.prepare(`PRAGMA table_info(relations)`).all() as Array<{ name: string }>;
    const relColNames = new Set(relCols.map(c => c.name));

    if (!relColNames.has('last_accessed')) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN last_accessed INTEGER;`);
    }
    if (!relColNames.has('access_count')) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;`);
    }

    // Indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_confidence_entity ON confidence_log(entity_id);
      CREATE INDEX IF NOT EXISTS idx_confidence_relation ON confidence_log(relation_id);
      CREATE INDEX IF NOT EXISTS idx_somatic_area ON somatic_events(area);
      CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence) WHERE confidence < 1.0;
      CREATE INDEX IF NOT EXISTS idx_entities_status ON entities(status) WHERE status != 'active';
    `);
  }

  // ─── Entity Confidence ───────────────────────────────────────────────────────

  /**
   * Record an access on an entity — updates access_count and last_accessed.
   */
  recordEntityAccess(entityId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE entities 
      SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed = ?
      WHERE id = ?
    `).run(now, entityId);
  }

  /**
   * Record an access on a relation.
   */
  recordRelationAccess(relationId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE relations 
      SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed = ?
      WHERE id = ?
    `).run(now, relationId);
  }

  /**
   * Apply a confidence delta to an entity.
   * Logs the change, clamps to [0.0, 1.0], and marks dormant if <= threshold.
   */
  adjustEntityConfidence(
    entityId: string,
    delta: number,
    reason: ConfidenceReason,
    source: ConfidenceSource,
    reason_text?: string
  ): { old_confidence: number; new_confidence: number; became_dormant: boolean } {
    const entity = this.db.prepare('SELECT id, name, confidence, status, area FROM entities WHERE id = ?').get(entityId) as
      { id: string; name: string; confidence: number; status: string; area: string | null } | undefined;
    if (!entity) return { old_confidence: 0, new_confidence: 0, became_dormant: false };

    const old_confidence = entity.confidence ?? 1.0;
    const new_confidence = Math.max(0.0, Math.min(1.0, old_confidence + delta));

    // Somatic: area-level error tracking
    if ((reason === 'somatic_error' || reason === 'somatic_confirm') && entity.area) {
      const somatic_delta = reason === 'somatic_error' ? delta : Math.abs(delta);
      this.logSomaticEvent(entity.area, reason === 'somatic_error' ? 'error' : 'confirm', somatic_delta, reason_text);
      // Also apply area-based default adjustment
      const area_default = AREA_DEFAULTS[entity.area] ?? 1.0;
      const adjusted_delta = delta * (area_default < 1.0 ? area_default : 1.0);
    }

    let became_dormant = false;
    if (new_confidence <= DEFAULT_DORMANCY_THRESHOLD && entity.status === 'active') {
      this.db.prepare(`UPDATE entities SET status = 'dormant' WHERE id = ?`).run(entityId);
      became_dormant = true;
    }

    this.db.prepare(`UPDATE entities SET confidence = ? WHERE id = ?`).run(new_confidence, entityId);

    // Log the delta
    const logId = uuidv4();
    this.db.prepare(`
      INSERT INTO confidence_log (id, entity_id, delta, reason, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(logId, entityId, delta, reason, source, Date.now());

    return { old_confidence, new_confidence, became_dormant };
  }

  /**
   * Apply a confidence delta to a relation.
   */
  adjustRelationConfidence(
    relationId: string,
    delta: number,
    reason: ConfidenceReason,
    source: ConfidenceSource
  ): { old_confidence: number; new_confidence: number } {
    const rel = this.db.prepare('SELECT id, confidence FROM relations WHERE id = ?').get(relationId) as
      { id: string; confidence: number } | undefined;
    if (!rel) return { old_confidence: 0, new_confidence: 0 };

    const old_confidence = rel.confidence ?? 1.0;
    const new_confidence = Math.max(0.0, Math.min(1.0, old_confidence + delta));

    this.db.prepare(`UPDATE relations SET confidence = ? WHERE id = ?`).run(new_confidence, relationId);

    const logId = uuidv4();
    this.db.prepare(`
      INSERT INTO confidence_log (id, relation_id, delta, reason, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(logId, relationId, delta, reason, source, Date.now());

    return { old_confidence, new_confidence };
  }

  /**
   * Get the current confidence for an entity.
   */
  getEntityConfidence(entityId: string): number {
    const row = this.db.prepare('SELECT confidence FROM entities WHERE id = ?').get(entityId) as
      { confidence: number } | undefined;
    return row?.confidence ?? 1.0;
  }

  /**
   * Get all dormant entities.
   */
  getDormantEntities(): Array<{ id: string; name: string; type: string; confidence: number; last_accessed: number | null }> {
    return this.db.prepare(`
      SELECT id, name, type, confidence, last_accessed
      FROM entities
      WHERE status = 'dormant'
      ORDER BY confidence ASC, last_accessed ASC
    `).all() as Array<{ id: string; name: string; type: string; confidence: number; last_accessed: number | null }>;
  }

  /**
   * Reactivate a dormant entity.
   */
  reactivateEntity(entityId: string): void {
    this.db.prepare(`UPDATE entities SET status = 'active' WHERE id = ?`).run(entityId);
  }

  // ─── Conflict Surfacing ─────────────────────────────────────────────────────

  /**
   * Check if adding/updating a relation would conflict with an existing one.
   * Returns conflict details if a high-confidence contradictory relation exists.
   */
  checkConflict(
    subjectId: string,
    predicate: string,
    newObjectId: string,
    minConfidence: number = 0.5
  ): ConflictReport | null {
    // Find existing relations with same subject + predicate, different object
    const existing = this.db.prepare(`
      SELECT r.*, e.name as object_name
      FROM relations r
      JOIN entities e ON r.object_id = e.id
      WHERE r.subject_id = ?
        AND r.predicate = ?
        AND r.object_id != ?
        AND r.confidence >= ?
        AND r.valid_to IS NULL
    `).all(subjectId, predicate, newObjectId, minConfidence) as Array<{
      id: string; object_name: string; confidence: number; predicate: string
    }>;

    if (existing.length === 0) return null;

    const worst = existing.sort((a, b) => a.confidence - b.confidence)[0];
    const subject = this.db.prepare('SELECT name FROM entities WHERE id = ?').get(subjectId) as { name: string } | undefined;

    return {
      entity_id: subjectId,
      entity_name: subject?.name ?? subjectId,
      existing_predicate: worst.predicate,
      existing_value: worst.object_name,
      existing_confidence: worst.confidence,
      new_value: newObjectId,
      severity: worst.confidence >= 0.8 ? 'high' : worst.confidence >= 0.5 ? 'medium' : 'low',
    };
  }

  // ─── Somatic Events ────────────────────────────────────────────────────────

  /**
   * Log a somatic event for an area. Negative deltas reduce default confidence
   * for new entities in that area.
   */
  private logSomaticEvent(area: string, eventType: 'error' | 'correction' | 'confirm', delta: number, context?: string): void {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO somatic_events (id, area, event_type, delta, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, area, eventType, delta, context ?? null, Date.now());

    // Update area default — exponentially weighted moving average
    const current = AREA_DEFAULTS[area] ?? 1.0;
    const alpha = 0.1; // learning rate
    const new_default = Math.max(0.5, Math.min(1.0, current + alpha * delta));
    AREA_DEFAULTS[area] = new_default;
  }

  /**
   * Get the default confidence for new entities in an area.
   */
  getAreaDefault(area: string): number {
    return AREA_DEFAULTS[area] ?? 1.0;
  }

  /**
   * Get somatic event summary for an area.
   */
  getSomaticSummary(area: string): { error_count: number; confirm_count: number; net_delta: number } {
    const rows = this.db.prepare(`
      SELECT event_type, COUNT(*) as cnt, SUM(delta) as sum_delta
      FROM somatic_events
      WHERE area = ?
      GROUP BY event_type
    `).all(area) as Array<{ event_type: string; cnt: number; sum_delta: number }>;

    const errors = rows.find(r => r.event_type === 'error');
    const confirms = rows.find(r => r.event_type === 'confirm');

    return {
      error_count: errors?.cnt ?? 0,
      confirm_count: confirms?.cnt ?? 0,
      net_delta: (errors?.sum_delta ?? 0) + (confirms?.sum_delta ?? 0),
    };
  }

  // ─── Decay ──────────────────────────────────────────────────────────────────

  /**
   * Apply staleness decay to entities that haven't been accessed recently.
   * For entities with access_count == 0:
   *   - If created more than staleness_threshold_days ago, confidence -= decay_per_period
   *   - Capped at max_decay total
   * 
   * Returns a report of all affected entities.
   */
  applyDecay(
    options: {
      staleness_threshold_days?: number;
      decay_per_period?: number;
      max_decay?: number;
    } = {}
  ): DecayReport {
    const threshold_days = options.staleness_threshold_days ?? DEFAULT_DECAY_INTERVAL_DAYS;
    const decay_per_period = options.decay_per_period ?? DEFAULT_DECAY_AMOUNT;
    const max_decay = options.max_decay ?? DEFAULT_MAX_DECAY;

    const now = Date.now();
    const threshold_ms = threshold_days * 24 * 60 * 60 * 1000;
    const threshold_ts = now - threshold_ms;
    const threshold_iso = new Date(threshold_ts).toISOString();

    const details: DecayReport['details'] = [];
    let entities_affected = 0;
    let entities_dormant = 0;
    let entities_skipped = 0;
    let relations_affected = 0;

    // Find stale entities (never accessed, old enough)
    const staleEntities = this.db.prepare(`
      SELECT id, name, confidence, access_count, last_accessed, created_at, status, area
      FROM entities
      WHERE access_count = 0
        AND (last_accessed IS NULL OR last_accessed < ?)
        AND created_at < ?
        AND status = 'active'
        AND confidence > 0
    `).all(threshold_iso, threshold_ts) as Array<{
      id: string; name: string; confidence: number; access_count: number;
      last_accessed: number | null; created_at: number; status: string; area: string | null
    }>;

    for (const entity of staleEntities) {
      // Cap decay so total decay never exceeds max_decay from original confidence
      const total_possible_decay = 1.0 - entity.confidence;
      const allowed_decay = Math.min(decay_per_period, max_decay, total_possible_decay);

      if (allowed_decay < 0.001) {
        // Entity already accumulated max decay, or is fresh with zero decay history — skip silently
        entities_skipped++;
        continue;
      }

      const applied_delta = -allowed_decay;
      const new_conf = Math.max(0, entity.confidence - allowed_decay);

      let became_dormant = false;
      // Only mark dormant if confidence genuinely hit zero (not floating-point noise)
      if (new_conf === 0 && entity.confidence > 0) {
        this.db.prepare(`UPDATE entities SET status = 'dormant', confidence = 0 WHERE id = ?`).run(entity.id);
        became_dormant = true;
      } else if (new_conf === 0 && entity.confidence === 0) {
        // Already at zero, just update status
        this.db.prepare(`UPDATE entities SET status = 'dormant' WHERE id = ?`).run(entity.id);
        became_dormant = true;
      } else if (new_conf === 0) {
        this.db.prepare(`UPDATE entities SET status = 'dormant', confidence = 0 WHERE id = ?`).run(entity.id);
        became_dormant = true;
      } else {
        this.db.prepare(`UPDATE entities SET confidence = ? WHERE id = ?`).run(new_conf, entity.id);
      }

      // Log
      const logId = uuidv4();
      this.db.prepare(`
        INSERT INTO confidence_log (id, entity_id, delta, reason, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(logId, entity.id, applied_delta, 'decay', 'decay_cron', now);

      entities_affected++;
      if (became_dormant) entities_dormant++;

      details.push({
        entity_id: entity.id,
        name: entity.name,
        old_conf: entity.confidence,
        new_conf: new_conf,
        reason: became_dormant ? 'decay → dormant' : 'decay applied',
      });
    }

    // Find stale relations (never accessed, old enough)
    const staleRelations = this.db.prepare(`
      SELECT id, subject_id, predicate, object_id, confidence, access_count, last_accessed, created_at
      FROM relations
      WHERE access_count = 0
        AND (last_accessed IS NULL OR last_accessed < ?)
        AND created_at < ?
        AND confidence > 0
    `).all(threshold_iso, threshold_ts) as Array<{
      id: string; subject_id: string; predicate: string; object_id: string;
      confidence: number; access_count: number; last_accessed: number | null; created_at: number
    }>;

    for (const rel of staleRelations) {
      const max_possible_decay = Math.min(decay_per_period, max_decay - (1.0 - rel.confidence));
      if (max_possible_decay <= 0) continue;

      const applied_delta = -max_possible_decay;
      const new_conf = Math.max(0, rel.confidence + applied_delta);

      this.db.prepare(`UPDATE relations SET confidence = ? WHERE id = ?`).run(new_conf, rel.id);

      // Log
      const logId = uuidv4();
      this.db.prepare(`
        INSERT INTO confidence_log (id, relation_id, delta, reason, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(logId, rel.id, applied_delta, 'decay', 'decay_cron', now);

      relations_affected++;
    }

    return {
      entities_processed: staleEntities.length,
      entities_affected,
      entities_dormant,
      entities_skipped,
      relations_affected,
      details,
    };
  }

  // ─── Confidence History ──────────────────────────────────────────────────────

  /**
   * Get confidence change history for an entity.
   */
  getConfidenceHistory(entityId: string, days: number = 7): ConfidenceDelta[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT entity_id, relation_id, delta, reason, source, created_at
      FROM confidence_log
      WHERE entity_id = ? AND created_at >= ?
      ORDER BY created_at ASC, rowid ASC
    `).all(entityId, cutoff) as ConfidenceDelta[];
  }

  /**
   * Get confidence history for a relation.
   */
  getRelationConfidenceHistory(relationId: string, days: number = 7): ConfidenceDelta[] {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT entity_id, relation_id, delta, reason, source, created_at
      FROM confidence_log
      WHERE relation_id = ? AND created_at >= ?
      ORDER BY created_at ASC, rowid ASC
    `).all(relationId, cutoff) as ConfidenceDelta[];
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  /**
   * Get summary stats about confidence system.
   */
  stats(): {
    total_entities: number;
    active_entities: number;
    dormant_entities: number;
    avg_confidence: number;
    low_confidence_count: number;
    zero_access_entities: number;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c;
    const active = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE status = 'active'`).get() as { c: number }).c;
    const dormant = (this.db.prepare(`SELECT COUNT(*) as c FROM entities WHERE status = 'dormant'`).get() as { c: number }).c;
    const avg_conf = (this.db.prepare('SELECT AVG(confidence) as avg FROM entities').get() as { avg: number | null }).avg ?? 1.0;
    const low_conf = (this.db.prepare('SELECT COUNT(*) as c FROM entities WHERE confidence < 0.8').get() as { c: number }).c;
    const zero_access = (this.db.prepare('SELECT COUNT(*) as c FROM entities WHERE confidence < 1.0 AND access_count = 0').get() as { c: number }).c;

    return { total_entities: total, active_entities: active, dormant_entities: dormant, avg_confidence: avg_conf, low_confidence_count: low_conf, zero_access_entities: zero_access };
  }

  close(): void {
    this.db.close();
  }
}
