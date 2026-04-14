/**
 * AthenaMem Contradiction Detection Engine
 *
 * Every memory retain operation checks new facts against the existing KG.
 * If a new assertion conflicts with an existing one (temporal overlap + different predicate),
 * the memory is flagged and the agent is notified.
 */

import { KnowledgeGraph, Memory, EntityType } from './kg.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Fact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  source?: string;
  timestamp?: number;
}

export interface Contradiction {
  new_fact: Fact;
  existing_fact: Fact;
  existing_entity_id: string;
  severity: 'high' | 'medium' | 'low';
  reason: string;
  memoryId?: string; // Associated memory ID that triggered this contradiction
  memory_id?: string; // Alternative field name for compatibility
}

export interface CheckResult {
  has_contradiction: boolean;
  contradictions: Contradiction[];
  new_entities: { name: string; type: string }[];
  warnings: string[];
}

// ─── Predicate conflict matrix ─────────────────────────────────────────────────

const PREDICATE_CONFLICTS: Record<string, string[]> = {
  'decided': ['rejected'],
  'rejected': ['decided', 'recommended'],
  'prefers': ['prefers'],
  'works_on': ['completed', 'failed'],
  'completed': ['works_on', 'assigned_to'],
  'assigned_to': ['completed', 'failed'],
  'failed': ['succeeded', 'completed'],
  'succeeded': ['failed'],
  'recommended': ['rejected'],
  'owns': ['mentioned'],
  'mentioned': ['owns'],
  'related_to': [],
  'depends_on': [],
  'created': ['updated'],
  'updated': ['created'],
  'learned': [],
};

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Extract structured facts from raw text using pattern matching.
 * Lightweight extractor — for production, replace with LLM extraction.
 */
export function extractFacts(text: string, source?: string, timestamp?: number): Fact[] {
  const facts: Fact[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const now = timestamp ?? Date.now();

  for (const line of lines) {
    // "[Entity] works on [Object]"
    const worksOn = line.match(/([A-Z][a-zA-Z]+)\s+(?:works on|is working on|assigned to)\s+(.+)/i);
    if (worksOn) {
      facts.push({ subject: worksOn[1], predicate: 'works_on', object: worksOn[2].trim(), confidence: 0.9, source, timestamp: now });
    }

    // "[Entity] completed [Object]"
    const completed = line.match(/([A-Z][a-zA-Z]+)\s+(?:completed|finished)\s+(.+)/i);
    if (completed) {
      facts.push({ subject: completed[1], predicate: 'completed', object: completed[2].trim(), confidence: 0.9, source, timestamp: now });
    }

    // "[Entity] decided [to|on] [Object]"
    const decided = line.match(/([A-Z][a-zA-Z]+)\s+decided\s+(?:to\s+|on\s+)?(.+)/i);
    if (decided) {
      facts.push({ subject: decided[1], predicate: 'decided', object: decided[2].trim(), confidence: 0.85, source, timestamp: now });
    }

    // "[Entity] rejected [Object]"
    const rejected = line.match(/([A-Z][a-zA-Z]+)\s+rejected\s+(.+)/i);
    if (rejected) {
      facts.push({ subject: rejected[1], predicate: 'rejected', object: rejected[2].trim(), confidence: 0.85, source, timestamp: now });
    }

    // "[Entity] prefers [Object]"
    const prefers = line.match(/([A-Z][a-zA-Z]+)\s+prefers?\s+(.+)/i);
    if (prefers) {
      facts.push({ subject: prefers[1], predicate: 'prefers', object: prefers[2].trim(), confidence: 0.8, source, timestamp: now });
    }

    // "[Entity] learned [Object]"
    const learned = line.match(/([A-Z][a-zA-Z]+)\s+(?:learned|discovered|found)\s+(?:that\s+)?(.+)/i);
    if (learned) {
      facts.push({ subject: learned[1], predicate: 'learned', object: learned[2].trim(), confidence: 0.75, source, timestamp: now });
    }

    // "The team chose [Object] over [Other]"
    const choseOver = line.match(/chose\s+(\w+)\s+over\s+(\w+)/i);
    if (choseOver) {
      facts.push({ subject: 'Team', predicate: 'decided', object: choseOver[1], confidence: 0.8, source, timestamp: now });
      facts.push({ subject: 'Team', predicate: 'rejected', object: choseOver[2], confidence: 0.8, source, timestamp: now });
    }

    // "[Entity] recommended [Object]"
    const recommended = line.match(/([A-Z][a-zA-Z]+)\s+recommended\s+(.+)/i);
    if (recommended) {
      facts.push({ subject: recommended[1], predicate: 'recommended', object: recommended[2].trim(), confidence: 0.85, source, timestamp: now });
    }

    // "[Entity] failed [Object]"
    const failed = line.match(/([A-Z][a-zA-Z]+)\s+(?:failed|failed to)\s+(.+)/i);
    if (failed) {
      facts.push({ subject: failed[1], predicate: 'failed', object: failed[2].trim(), confidence: 0.9, source, timestamp: now });
    }

    // "[Entity] succeeded [Object]"
    const succeeded = line.match(/([A-Z][a-zA-Z]+)\s+succeeded\s+(?:with|in|at)\s+(.+)/i);
    if (succeeded) {
      facts.push({ subject: succeeded[1], predicate: 'succeeded', object: succeeded[2].trim(), confidence: 0.9, source, timestamp: now });
    }

    // "[Entity] owns [Object]"
    const owns = line.match(/([A-Z][a-zA-Z]+)\s+owns\s+(.+)/i);
    if (owns) {
      facts.push({ subject: owns[1], predicate: 'owns', object: owns[2].trim(), confidence: 0.9, source, timestamp: now });
    }

    // "The sky is blue" / "Sky is blue" / "Chris is tired"
    const copula = line.match(/^(?:The\s+)?([A-Za-z][A-Za-z0-9_-]*)\s+is\s+(.+)$/i);
    if (copula) {
      facts.push({ subject: copula[1], predicate: 'is', object: copula[2].trim(), confidence: 0.8, source, timestamp: now });
    }
  }

  return facts;
}

// ─── Detection Engine ─────────────────────────────────────────────────────────

export class ContradictionDetector {
  private kg: KnowledgeGraph;

  constructor(kg: KnowledgeGraph) {
    this.kg = kg;
  }

  check(facts: Fact[]): CheckResult {
    const contradictions: Contradiction[] = [];
    const newEntities: { name: string; type: string }[] = [];

    for (const fact of facts) {
      const entityType = this.inferEntityType(fact.subject);
      const objectType = this.inferEntityType(fact.object);

      let subjectEntity = this.kg.getEntityByName(fact.subject) ?? this.kg.getEntity(fact.subject, entityType as EntityType);
      if (!subjectEntity) {
        newEntities.push({ name: fact.subject, type: entityType });
        subjectEntity = this.kg.addEntity(fact.subject, entityType as EntityType);
      }

      let objectEntity = this.kg.getEntityByName(fact.object) ?? this.kg.getEntity(fact.object, objectType as EntityType);
      if (!objectEntity) {
        newEntities.push({ name: fact.object, type: objectType });
        objectEntity = this.kg.addEntity(fact.object, objectType as EntityType);
      }

      const existingRelations = this.kg.queryRelations(subjectEntity.id);

      for (const existing of existingRelations) {
        if (existing.object_id !== objectEntity!.id) continue;

        const conflictPredicates = PREDICATE_CONFLICTS[existing.predicate] ?? [];
        if (conflictPredicates.includes(fact.predicate)) {
          const hasOverlap = this.checkTemporalOverlap(existing, fact.timestamp ?? Date.now());
          if (hasOverlap) {
            const severity = this.calculateSeverity(existing.predicate, fact.predicate);
            contradictions.push({
              new_fact: fact,
              existing_fact: {
                subject: fact.subject,
                predicate: existing.predicate,
                object: fact.object,
                confidence: existing.confidence,
                source: existing.source ?? undefined,
                timestamp: existing.valid_from,
              },
              existing_entity_id: existing.id,
              severity,
              reason: `Predicate '${existing.predicate}' conflicts with '${fact.predicate}' for subject '${fact.subject}' and object '${fact.object}' (temporal overlap detected)`,
            });
          }
        }
      }

      // Check same-predicate, different-object
      const samePredicate = existingRelations.filter(r => r.predicate === fact.predicate && r.object_id !== objectEntity!.id);
      for (const existing of samePredicate) {
        const objEntity = this.kg.queryEntities({ entity_id: existing.object_id })[0];
        const hasOverlap = this.checkTemporalOverlap(existing, fact.timestamp ?? Date.now());
        if (hasOverlap) {
          contradictions.push({
            new_fact: fact,
            existing_fact: {
              subject: fact.subject,
              predicate: existing.predicate,
              object: objEntity?.name ?? existing.object_id,
              confidence: existing.confidence,
              source: existing.source ?? undefined,
              timestamp: existing.valid_from,
            },
            existing_entity_id: existing.id,
            severity: 'high',
            reason: `Subject '${fact.subject}' already has predicate '${fact.predicate}' with object '${objEntity?.name ?? existing.object_id}', new value is '${fact.object}'`,
          });
        }
      }

      // Fallback: compare against extracted facts from existing memories when the KG
      // does not yet hold a structured relation for this predicate.
      const existingMemories = this.kg.searchMemories(fact.subject, undefined, undefined, 100);
      for (const existingMemory of existingMemories) {
        if (existingMemory.id === fact.source) continue;
        const existingFacts = extractFacts(existingMemory.content, existingMemory.id, existingMemory.created_at);
        for (const existingFact of existingFacts) {
          if (existingFact.subject.toLowerCase() !== fact.subject.toLowerCase()) continue;
          if (existingFact.predicate !== fact.predicate) continue;
          if (existingFact.object.toLowerCase() === fact.object.toLowerCase()) continue;

          contradictions.push({
            new_fact: fact,
            existing_fact: existingFact,
            existing_entity_id: existingMemory.id,
            severity: 'high',
            reason: `Subject '${fact.subject}' already has predicate '${fact.predicate}' with object '${existingFact.object}', new value is '${fact.object}'`,
            memoryId: existingMemory.id,
          });
        }
      }
    }

    return {
      has_contradiction: contradictions.length > 0,
      contradictions,
      new_entities: newEntities,
      warnings: contradictions.length > 0 ? [`Found ${contradictions.length} contradiction(s) — memories will be flagged`] : [],
    };
  }

  private inferEntityType(name: string): string {
    const lower = name.toLowerCase();
    if (['team', 'we', 'everyone', 'they'].includes(lower)) return 'agent';
    if (lower.includes('project') || lower.includes('initiative')) return 'project';
    if (/^[a-z][a-z0-9_-]*$/.test(name)) return 'topic';
    return 'person';
  }

  private checkTemporalOverlap(existing: { valid_from: number; valid_to: number | null }, newTimestamp: number): boolean {
    if (!existing.valid_to) {
      return existing.valid_from <= newTimestamp;
    }
    return existing.valid_from <= newTimestamp && existing.valid_to >= newTimestamp;
  }

  private calculateSeverity(pred1: string, pred2: string): 'high' | 'medium' | 'low' {
    const highPairs = [['decided', 'rejected'], ['succeeded', 'failed'], ['prefers', 'prefers']];
    const pair = [pred1, pred2].sort().join('|');
    if (highPairs.some(p => p.sort().join('|') === pair)) return 'high';
    return 'medium';
  }

  formatReport(result: CheckResult): string {
    if (!result.has_contradiction) return '✅ No contradictions detected';

    const lines: string[] = [];
    lines.push(`⚠️  ${result.contradictions.length} contradiction(s) found:\n`);

    for (const c of result.contradictions) {
      const emoji = c.severity === 'high' ? '🔴' : c.severity === 'medium' ? '🟡' : '🟢';
      lines.push(`${emoji} [${c.severity.toUpperCase()}]`);
      lines.push(`   New: ${c.new_fact.subject} → ${c.new_fact.predicate} → ${c.new_fact.object}`);
      lines.push(`   Existing: ${c.existing_fact.subject} → ${c.existing_fact.predicate} → ${c.existing_fact.object}`);
      lines.push(`   Reason: ${c.reason}`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ─── Integration helper ────────────────────────────────────────────────────────

export function checkAndFlagContradictions(
  kg: KnowledgeGraph,
  memory: Memory,
  text: string
): CheckResult {
  const detector = new ContradictionDetector(kg);
  const facts = extractFacts(text, memory.id);
  const result = detector.check(facts);

  if (result.has_contradiction) {
    for (const c of result.contradictions) {
      kg.flagContradiction(memory.id, c.existing_entity_id);
    }
  }

  return result;
}
