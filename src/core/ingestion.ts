/**
 * AthenaMem Unified Memory Ingestion Pipeline
 * 
 * Single entry point for all memory writes. Provides:
 * - Durable event logging via WAL
 * - Normalized memory storage
 * - Fact extraction and KG updates
 * - Contradiction detection
 * - Salience scoring
 * - State tracking
 */

import { v4 as uuidv4 } from 'uuid';
import { KnowledgeGraph, Memory, HallType, MemoryType, EntityType } from './kg.js';
import { Palace } from './palace.js';
import { WALManager } from './wal.js';
import { ContradictionDetector, extractFacts, checkAndFlagContradictions } from './contradiction.js';
import { scoreSalience } from './salience.js';
import {
  MemoryEvent,
  CategoryType,
  MemorySource,
  IngestionResult,
  SalienceInput,
} from './event.js';

// Re-declare inferEntityType here to avoid circular dependencies
function inferEntityType(name: string, defaultType: EntityType = 'person'): EntityType {
  const lower = name.toLowerCase();

  if (/^\d{4}-\d{2}-\d{2}$/.test(name) || /\b(today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(lower)) return 'date';
  if (/\b(room|office|plant|shop|warehouse|site|hq|home|house|lab|mte)\b/.test(lower) || /,\s*[A-Z]{2}$/.test(name)) return 'location';
  
  if (/\b(app|project|system|service|api|bot|agent|tool)\b/.test(lower)) return 'project';
  if (/\b(decision|choice|option|plan|strategy)\b/.test(lower)) return 'decision';
  if (/\b(topic|concept|idea|pattern|architecture)\b/.test(lower)) return 'topic';
  if (/\b(lesson|insight|learning|realization)\b/.test(lower)) return 'lesson';
  if (/\b(preference|setting|config|default)\b/.test(lower)) return 'preference';
  if (/\b(athena|athenamem|openclaw|codex|claude|gpt)\b/.test(lower)) return 'agent';
  if (/^[A-Z][a-z]+$/.test(name) || name.includes('@')) return 'person';
  
  return defaultType;
}

export interface IngestionOptions {
  skipWAL?: boolean;
  skipContradictionCheck?: boolean;
  skipKGUpdate?: boolean;
  skipSalience?: boolean;
  extractFacts?: boolean;
}

export interface IngestionContext {
  kg: KnowledgeGraph;
  palace: Palace;
  wal: WALManager;
  detector: ContradictionDetector;
  sessionId: string;
  agentId: string;
}

/**
 * Unified memory ingestion pipeline
 * 
 * This is THE single entry point for all memory writes in AthenaMem.
 * Every tool that creates memory must call this function.
 */
export async function ingestMemoryEvent(
  ctx: IngestionContext,
  event: Omit<MemoryEvent, 'id' | 'createdAt' | 'state'>,
  options: IngestionOptions = {}
): Promise<IngestionResult> {
  const startTime = Date.now();
  const warnings: string[] = [];

  try {
    // 1. Create normalized event with metadata
    const fullEvent: MemoryEvent = {
      ...event,
      id: uuidv4(),
      createdAt: Date.now(),
      state: 'raw',
    };

    // 2. Write to WAL for durability (unless skipped)
    if (!options.skipWAL) {
      ctx.wal.begin({
        session_state: JSON.stringify({
          type: 'memory_ingestion',
          eventId: fullEvent.id,
          source: fullEvent.source,
        }),
      });
    }

    // 3. Compute salience score
    let salienceScore = 0.5;
    if (typeof fullEvent.salienceOverride === 'number') {
      salienceScore = Math.max(0, Math.min(1, fullEvent.salienceOverride));
      fullEvent.salience = salienceScore;
    } else if (!options.skipSalience) {
      const salienceInput: SalienceInput = {
        category: fullEvent.category,
        content: fullEvent.content,
        isPreference: fullEvent.category === 'preference',
        isProjectMemory: fullEvent.category === 'project',
        isDecision: fullEvent.category === 'decision',
      };
      const salienceResult = scoreSalience(salienceInput);
      salienceScore = salienceResult.score;
      fullEvent.salience = salienceScore;
    }

    // 4. Store verbatim memory in Palace/Structure
    // Determine hall type from category
    const hallType = mapCategoryToHall(fullEvent.category);
    
    const { drawer, memory } = ctx.palace.addDrawer(
      fullEvent.moduleName,
      fullEvent.sectionName,
      hallType,
      fullEvent.provenance.filePath ?? `${fullEvent.source}/${fullEvent.id}.md`,
      fullEvent.content
    );

    // Update memory with salience
    ctx.kg.updateMemorySalience(memory.id, salienceScore);

    // 5. Extract facts (if content has structured data)
    let factsExtracted = 0;
    if (options.extractFacts !== false && fullEvent.content) {
      const facts = extractFacts(fullEvent.content);
      fullEvent.extractedFacts = facts;
      factsExtracted = facts.length;

      // 6. Update KG with extracted facts
      if (!options.skipKGUpdate && facts.length > 0) {
        for (const fact of facts) {
          try {
            const subjectType = inferEntityType(fact.subject, 'person');
            const objectType = inferEntityType(fact.object, 'person');
            const subject = ctx.kg.addEntity(fact.subject, subjectType);
            const object = ctx.kg.addEntity(fact.object, objectType);
            ctx.kg.addRelation(
              subject.id,
              fact.predicate as any,
              object.id,
              fact.confidence,
              memory.id  // Track source memory
            );
          } catch (err) {
            warnings.push(`Failed to add fact: ${fact.subject} ${fact.predicate} ${fact.object}`);
          }
        }
      }
    }

    // 7. Check for contradictions
    let contradictionsDetected = 0;
    if (!options.skipContradictionCheck) {
      const contradictionResult = checkAndFlagContradictions(ctx.kg, memory, fullEvent.content);
      contradictionsDetected = contradictionResult.contradictions.length;
      
      if (contradictionsDetected > 0) {
        fullEvent.state = 'contradicted';
        fullEvent.contradictionIds = contradictionResult.contradictions
          .map(c => c.memoryId || c.memory_id)
          .filter((id): id is string => id !== undefined);
        warnings.push(`${contradictionsDetected} contradiction(s) detected`);
      } else {
        fullEvent.state = 'indexed';
      }
    } else {
      fullEvent.state = 'indexed';
    }

    // 8. Commit WAL
    if (!options.skipWAL) {
      ctx.wal.commit();
    }

    const processingTimeMs = Date.now() - startTime;

    return {
      success: true,
      memoryId: memory.id,
      drawerId: drawer.drawer_id,
      salienceScore,
      contradictionsDetected,
      factsExtracted,
      warnings,
      processingTimeMs,
    };

  } catch (err) {
    const processingTimeMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    // Rollback WAL on failure
    if (!options.skipWAL) {
      try {
        ctx.wal.recover();
      } catch {
        // Ignore recovery errors
      }
    }

    return {
      success: false,
      memoryId: '',
      salienceScore: 0,
      contradictionsDetected: 0,
      factsExtracted: 0,
      warnings: [errorMsg, ...warnings],
      processingTimeMs,
    };
  }
}

/**
 * Map category type to Palace hall type
 */
function mapCategoryToHall(category: CategoryType): HallType {
  const mapping: Record<CategoryType, HallType> = {
    preference: 'facts',
    project: 'discoveries',
    decision: 'discoveries',
    lesson: 'discoveries',
    person: 'facts',
    system: 'discoveries',
    discoveries: 'discoveries',
    general: 'discoveries',
  };
  return mapping[category] ?? 'discoveries';
}

/**
 * Batch ingestion for import operations
 */
export async function ingestMemoryBatch(
  ctx: IngestionContext,
  events: Array<Omit<MemoryEvent, 'id' | 'createdAt' | 'state'>>,
  options: IngestionOptions = {}
): Promise<IngestionResult[]> {
  const results: IngestionResult[] = [];
  
  for (const event of events) {
    const result = await ingestMemoryEvent(ctx, event, options);
    results.push(result);
  }
  
  return results;
}
