import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeGraph } from './kg.js';
import { ConfidenceStore, ConflictReport } from './confidence.js';
import * as fs from 'fs';

const TEST_DB = '/tmp/athenamem-confidence-test.db';

function freshKG(): KnowledgeGraph {
  try { fs.unlinkSync(TEST_DB); } catch { try { fs.unlinkSync(TEST_DB + '-wal'); } catch {} try { fs.unlinkSync(TEST_DB + '-shm'); } catch {} }
  return new KnowledgeGraph(TEST_DB);
}

function storeForKG(kg: KnowledgeGraph): ConfidenceStore {
  // ConfidenceStore uses the same DB path as KG
  return new ConfidenceStore(TEST_DB);
}

describe('ConfidenceStore', () => {
  beforeEach(() => {
    try { fs.unlinkSync(TEST_DB); } catch { try { fs.unlinkSync(TEST_DB + '-wal'); } catch {} try { fs.unlinkSync(TEST_DB + '-shm'); } catch {} }
  });

  describe('entity confidence', () => {
    it('adjusts confidence down on user correction', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('BadEntity', 'topic');
      const result = store.adjustEntityConfidence(entity.id, -0.3, 'user_correction', 'user_feedback');
      expect(result.old_confidence).toBe(1.0);
      expect(result.new_confidence).toBe(0.7);
      kg.close();
    });

    it('clamps at 0.0 on large negative delta', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('CappedEntity', 'topic');
      const result = store.adjustEntityConfidence(entity.id, -2.0, 'somatic_error', 'kg_inference');
      expect(result.new_confidence).toBe(0.0);
      kg.close();
    });

    it('does not exceed 1.0 on positive delta', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('GoodEntity', 'topic');
      const result = store.adjustEntityConfidence(entity.id, 0.5, 'user_confirmation', 'user_feedback');
      expect(result.new_confidence).toBe(1.0); // capped
      kg.close();
    });

    it('marks entity dormant when confidence hits 0', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('DyingEntity', 'topic');
      // Manually set confidence low first
      (kg as any).db.prepare(`UPDATE entities SET confidence = ? WHERE id = ?`).run(0.2, entity.id);
      const result = store.adjustEntityConfidence(entity.id, -0.3, 'user_correction', 'user_feedback');
      expect(result.became_dormant).toBe(true);
      expect(result.new_confidence).toBe(0.0);
      kg.close();
    });

    it('returns zeros for non-existent entity', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const result = store.adjustEntityConfidence('nonexistent', -0.3, 'user_correction', 'user_feedback');
      expect(result.old_confidence).toBe(0);
      expect(result.new_confidence).toBe(0);
      kg.close();
    });
  });

  describe('access tracking', () => {
    it('records entity access', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('AccessedEntity', 'topic');
      store.recordEntityAccess(entity.id);
      const row = (kg as any).db.prepare(`SELECT access_count FROM entities WHERE id = ?`).get(entity.id) as any;
      expect(row.access_count).toBe(1);
      expect(row.last_accessed).not.toBeNull();
      kg.close();
    });

    it('increments on repeated access', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('MultiAccessed', 'topic');
      store.recordEntityAccess(entity.id);
      store.recordEntityAccess(entity.id);
      store.recordEntityAccess(entity.id);
      const row = (kg as any).db.prepare(`SELECT access_count FROM entities WHERE id = ?`).get(entity.id) as any;
      expect(row.access_count).toBe(3);
      kg.close();
    });
  });

  describe('dormant entities', () => {
    it('returns all dormant entities', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      kg.addEntity('Active1', 'topic');
      kg.addEntity('Dormant1', 'topic');
      kg.addEntity('Dormant2', 'topic');
      (kg as any).db.prepare(`UPDATE entities SET status = 'dormant' WHERE name IN ('Dormant1', 'Dormant2')`).run();
      const dormant = store.getDormantEntities();
      expect(dormant).toHaveLength(2);
      kg.close();
    });

    it('reactivates a dormant entity', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e = kg.addEntity('WasDormant', 'topic');
      (kg as any).db.prepare(`UPDATE entities SET status = 'dormant' WHERE id = ?`).run(e.id);
      store.reactivateEntity(e.id);
      const row = (kg as any).db.prepare(`SELECT status FROM entities WHERE id = ?`).get(e.id) as any;
      expect(row.status).toBe('active');
      kg.close();
    });
  });

  describe('conflict surfacing', () => {
    it('returns null when no conflict exists (different predicates)', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e1 = kg.addEntity('ProjectX', 'project');
      const e2 = kg.addEntity('TaskA', 'topic');
      const e3 = kg.addEntity('TaskB', 'topic');
      kg.addRelation(e1.id, 'works_on', e2.id);
      // different predicate — no conflict
      const conflict = store.checkConflict(e1.id, 'completed', e3.id);
      expect(conflict).toBeNull();
      kg.close();
    });

    it('detects conflict when same predicate with different high-confidence object', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e1 = kg.addEntity('ProjectX', 'project');
      const e2 = kg.addEntity('TaskA', 'topic');
      const e3 = kg.addEntity('TaskB', 'topic');
      kg.addRelation(e1.id, 'decided', e2.id, 0.9);
      // same predicate, different object — conflict
      const conflict = store.checkConflict(e1.id, 'decided', e3.id, 0.5);
      expect(conflict).not.toBeNull();
      expect(conflict!.severity).toBe('high');
      expect(conflict!.existing_value).toBe('TaskA');
      expect(conflict!.existing_confidence).toBe(0.9);
      kg.close();
    });

    it('ignores low-confidence existing relations', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e1 = kg.addEntity('ProjectX', 'project');
      const e2 = kg.addEntity('OldTask', 'topic');
      const e3 = kg.addEntity('NewTask', 'topic');
      kg.addRelation(e1.id, 'works_on', e2.id, 0.3); // low confidence
      const conflict = store.checkConflict(e1.id, 'works_on', e3.id, 0.5);
      expect(conflict).toBeNull();
      kg.close();
    });
  });

  describe('decay', () => {
    it('does not decay recently accessed entities', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('RecentEntity', 'topic');
      // Access it recently
      (kg as any).db.prepare(`UPDATE entities SET last_accessed = ?, access_count = 5 WHERE id = ?`)
        .run(Date.now() - 86400000, entity.id);
      const report = store.applyDecay({ staleness_threshold_days: 30 });
      expect(report.entities_affected).toBe(0);
      kg.close();
    });

    it('decays entities with zero access and old creation', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('StaleEntity', 'topic');
      // Set access_count=0, last_accessed and created_at both old so it's genuinely stale
      const oldTs = Date.now() - (40 * 24 * 60 * 60 * 1000);
      (kg as any).db.prepare(`UPDATE entities SET access_count = 0, last_accessed = ?, created_at = ?, confidence = 0.9 WHERE id = ?`)
        .run(oldTs, oldTs, entity.id);
      // default decay_per_period=0.1: new_conf = max(0, 0.9 - 0.1) = 0.8
      const report = store.applyDecay({ staleness_threshold_days: 30 });
      expect(report.entities_affected).toBe(1);
      expect(report.details[0].entity_id).toBe(entity.id);
      expect(report.details[0].new_conf).toBeCloseTo(0.8, 4);
      kg.close();
    });

    it('caps decay at max_decay', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('VeryStale', 'topic');
      // entity at 0.8, decay_per_period=0.5, max_decay=0.3
      // total_possible_decay = 0.2, allowed_decay = min(0.5, 0.3, 0.2) = 0.2
      // new_conf = 0.8 - 0.2 = 0.6 — total decay capped at max_decay=0.3 (1.0 - 0.8 = 0.2 which is less than 0.3)
      (kg as any).db.prepare(`UPDATE entities SET access_count = 0, created_at = ?, confidence = 0.8 WHERE id = ?`)
        .run(Date.now() - (90 * 24 * 60 * 60 * 1000), entity.id);
      const report = store.applyDecay({ staleness_threshold_days: 30, decay_per_period: 0.5, max_decay: 0.3 });
      const detail = report.details.find(d => d.entity_id === entity.id);
      expect(detail!).toBeDefined();
      expect(detail!.new_conf).toBeCloseTo(0.6, 5); // 0.8 - 0.2 = 0.6
      kg.close();
    });

    it('marks entity dormant after sufficient decay', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('DecayToDormant', 'topic');
      // allowed_decay = min(0.3, 0.5, 0.8) = 0.3 → new_conf = 0.2 - 0.3 = 0.0 → dormant
      (kg as any).db.prepare(`UPDATE entities SET access_count = 0, created_at = ?, confidence = 0.2 WHERE id = ?`)
        .run(Date.now() - (40 * 24 * 60 * 60 * 1000), entity.id);
      // decay_per_period=1.0, max_decay=0.5: allowed = min(1.0, 0.5, 0.8) = 0.5, new_conf = max(0, 0.2-0.5) = 0 → dormant
      const report = store.applyDecay({ staleness_threshold_days: 30, decay_per_period: 1.0 });
      expect(report.entities_dormant).toBe(1);
      kg.close();
    });
  });

  describe('confidence history', () => {
    it('logs all confidence changes', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('HistoryEntity', 'topic');
      store.adjustEntityConfidence(entity.id, -0.3, 'user_correction', 'user_feedback');
      store.adjustEntityConfidence(entity.id, 0.1, 'user_confirmation', 'user_feedback');
      const history = store.getConfidenceHistory(entity.id, 7);
      expect(history).toHaveLength(2);
      expect(history[0].reason).toBe('user_correction'); // oldest first (ASC)
      expect(history[1].reason).toBe('user_confirmation');
      kg.close();
    });
  });

  describe('relation confidence', () => {
    it('adjusts relation confidence', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e1 = kg.addEntity('S1', 'topic');
      const e2 = kg.addEntity('O1', 'topic');
      const rel = kg.addRelation(e1.id, 'works_on', e2.id, 1.0).relation;
      const result = store.adjustRelationConfidence(rel.id, -0.4, 'somatic_error', 'kg_inference');
      expect(result.old_confidence).toBe(1.0);
      expect(result.new_confidence).toBe(0.6);
      kg.close();
    });
  });

  describe('somatic events', () => {
    it('returns default area confidence', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      expect(store.getAreaDefault('health')).toBe(1.0);
      expect(store.getAreaDefault('project')).toBe(1.0);
      expect(store.getAreaDefault('unknown_area')).toBe(1.0);
      kg.close();
    });

    it('returns somatic summary for area', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const summary = store.getSomaticSummary('health');
      expect(summary.error_count).toBe(0);
      expect(summary.confirm_count).toBe(0);
      expect(summary.net_delta).toBe(0);
      kg.close();
    });
  });

  describe('stats', () => {
    it('returns accurate confidence stats', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      kg.addEntity('A1', 'topic');
      kg.addEntity('A2', 'topic');
      kg.addEntity('A3', 'topic');
      (kg as any).db.prepare(`UPDATE entities SET status = 'dormant', confidence = 0.0, access_count = 0 WHERE name = 'A3'`).run();
      (kg as any).db.prepare(`UPDATE entities SET confidence = 0.5, access_count = 0 WHERE name = 'A2'`).run();
      const stats = store.stats();
      expect(stats.total_entities).toBe(3);
      expect(stats.active_entities).toBe(2);
      expect(stats.dormant_entities).toBe(1);
      expect(stats.zero_access_entities).toBe(2);
      kg.close();
    });
  });

  describe('KG integration', () => {
    it('entity query excludes dormant by default', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e1 = kg.addEntity('ActiveEntity', 'topic');
      const e2 = kg.addEntity('DormantEntity', 'topic');
      (kg as any).db.prepare(`UPDATE entities SET status = 'dormant' WHERE id = ?`).run(e2.id);
      const results = kg.queryEntities({ entity_name: 'ActiveEntity' });
      expect(results).toHaveLength(1);
      const results2 = kg.queryEntities({ entity_name: 'DormantEntity' });
      expect(results2).toHaveLength(0); // dormant excluded by default
      kg.close();
    });

    it('include_stale param includes dormant entities', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const e1 = kg.addEntity('ActiveEntity', 'topic');
      const e2 = kg.addEntity('DormantEntity', 'topic');
      (kg as any).db.prepare(`UPDATE entities SET status = 'dormant' WHERE id = ?`).run(e2.id);
      const results = kg.queryEntities({ entity_name: 'DormantEntity', include_stale: true });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('DormantEntity');
      kg.close();
    });

    it('entity access is tracked on queryEntities', () => {
      const kg = freshKG();
      const store = storeForKG(kg);
      const entity = kg.addEntity('QueryTracked', 'topic');
      expect((kg as any).db.prepare(`SELECT access_count FROM entities WHERE id = ?`).get(entity.id) as any).toMatchObject({ access_count: 0 });
      kg.queryEntities({ entity_id: entity.id });
      expect((kg as any).db.prepare(`SELECT access_count FROM entities WHERE id = ?`).get(entity.id) as any).toMatchObject({ access_count: 1 });
      kg.close();
    });
  });
});
