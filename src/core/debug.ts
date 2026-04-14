/**
 * AthenaMem Debug Tools
 * 
 * Provides explainability and traceability for memory operations.
 * - trace_memory: Full audit trail of a memory
 * - explain_recall: Why did this memory rank here?
 */

import { KnowledgeGraph, Memory } from './kg.js';
import { Palace } from './palace.js';
import { WALManager } from './wal.js';

export interface MemoryTrace {
  memory: Memory;
  entry: {
    file_path: string;
    content_hash: string;
    created_at: number;
  } | null;
  facts: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
  }>;
  contradictions: Array<{
    memory_id: string;
    reason: string;
    status: 'active' | 'resolved';
  }>;
  lifecycle: {
    created: number;
    last_accessed: number | null;
    access_count: number;
    status: string;
    valid_to: number | null;
  };
  provenance: {
    source: string;
    extracted_from?: string;
    trigger_tool?: string;
  };
}

export interface RecallExplanation {
  query: string;
  top_results: Array<{
    rank: number;
    memory_id: string;
    content_preview: string;
    final_score: number;
    source_breakdown: Record<string, number>;
    salience: number;
    valid: boolean;
    contradicted: boolean;
    why_ranked: string[];
  }>;
  filters_applied: string[];
  sources_contributing: string[];
  reranking_applied: boolean;
}

/**
 * Trace a memory through its full lifecycle.
 */
export async function traceMemory(
  memoryId: string,
  kg: KnowledgeGraph,
  palace: Palace,
  wal: WALManager
): Promise<MemoryTrace | null> {
  const memory = kg.getMemory(memoryId);
  if (!memory) return null;

  // Get entry info
  const entry = kg.getEntry(memory.entry_id);

  // Get facts derived from this memory
  const facts = kg.queryRelations(memory.id)
    .filter(r => r.source === memory.id)
    .map(r => ({
      subject: r.subject_id,
      predicate: r.predicate,
      object: r.object_id,
      confidence: r.confidence,
    }));

  // Get contradictions
  const contradictions: MemoryTrace['contradictions'] = [];
  if (memory.contradiction_flag && memory.contradiction_with) {
    contradictions.push({
      memory_id: memory.contradiction_with,
      reason: 'Direct contradiction detected',
      status: 'active',
    });
  }

  return {
    memory,
    entry: entry ? {
      file_path: entry.file_path,
      content_hash: entry.content_hash,
      created_at: entry.created_at,
    } : null,
    facts,
    contradictions,
    lifecycle: {
      created: memory.created_at,
      last_accessed: memory.last_accessed,
      access_count: memory.access_count,
      status: memory.status,
      valid_to: memory.valid_to,
    },
    provenance: {
      source: memory.memory_type,
      // Would need to store trigger_tool in metadata
    },
  };
}

/**
 * Explain why memories were recalled for a query.
 */
export function explainRecall(
  query: string,
  results: Array<{
    memory: Memory;
    score: number;
    sourceScores: Record<string, number>;
    matched_keywords: string[];
  }>,
  filters: string[] = []
): RecallExplanation {
  return {
    query,
    top_results: results.slice(0, 5).map((r, i) => ({
      rank: i + 1,
      memory_id: r.memory.id,
      content_preview: r.memory.content.substring(0, 200) + '...',
      final_score: r.score,
      source_breakdown: r.sourceScores,
      salience: r.memory.importance,
      valid: r.memory.status === 'active',
      contradicted: r.memory.contradiction_flag,
      why_ranked: [
        ...r.matched_keywords.map(k => `Matched keyword: "${k}"`),
        r.memory.importance > 0.7 ? 'High salience score' : '',
        r.memory.access_count > 5 ? 'Frequently accessed' : '',
      ].filter(Boolean),
    })),
    filters_applied: filters,
    sources_contributing: [...new Set(results.flatMap(r => Object.keys(r.sourceScores)))],
    reranking_applied: results.length > 0 && results[0].score !== results[results.length - 1].score,
  };
}
