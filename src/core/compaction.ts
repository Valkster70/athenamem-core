/**
 * AthenaMem Compaction Engine — DAG-Based Memory Compression
 * 
 * Inspired by Mnemo Cortex's insight: memories are stored as a DAG where each
 * node is a summary that traces back to verbatim leaf nodes (raw messages).
 */

import { KnowledgeGraph, Memory, EntityType } from './kg.js';
import { extractFacts } from './contradiction.js';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompactionNode {
  id: string;
  level: 0 | 1 | 2 | 3;
  content: string;
  source_ids: string[];
  source_type: 'memory' | 'node';
  compression_ratio: number;
  token_count: number;
  created_at: number;
  last_accessed: number | null;
  access_count: number;
}

export interface CompactionStats {
  total_nodes: number;
  by_level: Record<number, number>;
  avg_compression_ratio: number;
  deepest_path: number;
  total_memories_compacted: number;
}

export interface CompactionResult {
  node: CompactionNode;
  savings_tokens: number;
  savings_percent: number;
}

// ─── Token Estimation ─────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function genId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// ─── CompactionEngine Class ───────────────────────────────────────────────────

export class CompactionEngine {
  private kg: KnowledgeGraph;
  private compactionDir: string;
  private nodes: Map<string, CompactionNode> = new Map();
  private llm: LLMCompiler;

  constructor(kg: KnowledgeGraph, compactionDir: string, llm: LLMCompiler) {
    this.kg = kg;
    this.compactionDir = compactionDir;
    this.llm = llm;
    if (!fs.existsSync(compactionDir)) {
      fs.mkdirSync(compactionDir, { recursive: true });
    }
    this.loadNodes();
  }

  private loadNodes(): void {
    try {
      const nodesFile = path.join(this.compactionDir, 'nodes.json');
      if (fs.existsSync(nodesFile)) {
        const data = JSON.parse(fs.readFileSync(nodesFile, 'utf-8')) as CompactionNode[];
        for (const node of data) {
          this.nodes.set(node.id, node);
        }
      }
    } catch { /* fresh start */ }
  }

  private saveNodes(): void {
    const nodesFile = path.join(this.compactionDir, 'nodes.json');
    const data = Array.from(this.nodes.values());
    fs.writeFileSync(nodesFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ─── Core Operations ────────────────────────────────────────────────────────

  async compact(
    sourceIds: string[],
    level: 1 | 2 | 3,
    module: string,
    section: string
  ): Promise<CompactionResult> {
    if (level < 1 || level > 3) {
      throw new Error('Compaction level must be 1, 2, or 3');
    }

    const sources: { id: string; content: string; type: 'memory' | 'node' }[] = [];
    for (const id of sourceIds) {
      const memories = this.kg.searchMemories('', undefined, undefined, 1000);
      const memory = memories.find(m => m.id === id);
      if (memory) {
        sources.push({ id, content: memory.content, type: 'memory' });
        continue;
      }
      const node = this.nodes.get(id);
      if (node) {
        sources.push({ id, content: node.content, type: 'node' });
      }
    }

    if (sources.length === 0) {
      throw new Error('No valid sources found for compaction');
    }

    const sourceContent = sources.map(s => s.content).join('\n---\n');
    const sourceTokens = estimateTokens(sourceContent);
    const targetTokens = this.targetTokens(sourceTokens, level);

    const prompt = this.buildCompactionPrompt(sourceContent, level, sources.length);
    const compressed = await this.llm.compile(prompt, targetTokens);
    const compressedTokens = estimateTokens(compressed);

    // Extract facts from the compressed content
    const facts = extractFacts(compressed, undefined, Date.now());
    for (const fact of facts) {
      const entityType = this.inferEntityType(fact.predicate) as EntityType;
      const subject = this.kg.addEntity(fact.subject, entityType);
      const object = this.kg.addEntity(fact.object, entityType);
      this.kg.addRelation(subject.id, fact.predicate as any, object.id, fact.confidence, sourceIds[0]);
    }

    const node: CompactionNode = {
      id: genId(),
      level,
      content: compressed,
      source_ids: sourceIds,
      source_type: sources[0].type,
      compression_ratio: compressedTokens / sourceTokens,
      token_count: compressedTokens,
      created_at: Date.now(),
      last_accessed: null,
      access_count: 0,
    };

    this.nodes.set(node.id, node);
    this.saveNodes();

    return {
      node,
      savings_tokens: sourceTokens - compressedTokens,
      savings_percent: Math.round((1 - compressedTokens / sourceTokens) * 100),
    };
  }

  expand(nodeId: string, depth: number = 0, maxDepth: number = 10): {
    content: string;
    sources: { id: string; content: string; type: string }[];
    depth: number;
  } {
    if (depth > maxDepth) {
      return { content: '[max depth reached]', sources: [], depth };
    }

    const node = this.nodes.get(nodeId);
    if (!node) {
      return { content: '[node not found]', sources: [], depth };
    }

    node.last_accessed = Date.now();
    node.access_count++;
    this.saveNodes();

    if (node.level === 0 || node.source_ids.length === 0) {
      return { content: node.content, sources: [{ id: node.id, content: node.content, type: 'memory' }], depth };
    }

    const allSources: { id: string; content: string; type: string }[] = [];
    const contents: string[] = [];

    for (const sourceId of node.source_ids) {
      const expanded = this.expand(sourceId, depth + 1, maxDepth);
      contents.push(expanded.content);
      allSources.push(...expanded.sources);
    }

    return { content: contents.join('\n---\n'), sources: allSources, depth: depth + 1 };
  }

  getActiveFrontier(): CompactionNode[] {
    return Array.from(this.nodes.values())
      .filter(n => n.level === 3)
      .sort((a, b) => b.access_count - a.access_count);
  }

  scheduleCompaction(memories: Memory[]): {
    toCompact: { ids: string[]; level: 1 | 2 | 3 }[];
    stats: CompactionStats;
  } {
    const toCompact: { ids: string[]; level: 1 | 2 | 3 }[] = [];
    const byLocation = new Map<string, Memory[]>();

    for (const m of memories) {
      const key = `${m.module}::${m.section}`;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push(m);
    }

    for (const [, mems] of byLocation) {
      if (mems.length < 3) continue;
      mems.sort((a, b) => b.importance - a.importance || b.access_count - a.access_count);

      if (mems.length >= 10) {
        toCompact.push({ ids: mems.slice(0, 5).map(m => m.id), level: 3 });
      } else if (mems.length >= 5) {
        toCompact.push({ ids: mems.slice(0, 3).map(m => m.id), level: 2 });
      } else if (mems.length >= 3) {
        toCompact.push({ ids: mems.map(m => m.id), level: 1 });
      }
    }

    return { toCompact, stats: this.stats() };
  }

  stats(): CompactionStats {
    const byLevel: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let totalCompression = 0;
    let deepestPath = 0;
    let totalCompacted = 0;

    for (const node of this.nodes.values()) {
      byLevel[node.level]++;
      totalCompression += node.compression_ratio;
      totalCompacted += node.source_ids.length;
    }

    return {
      total_nodes: this.nodes.size,
      by_level: byLevel,
      avg_compression_ratio: this.nodes.size > 0 ? totalCompression / this.nodes.size : 0,
      deepest_path: deepestPath,
      total_memories_compacted: totalCompacted,
    };
  }

  private targetTokens(sourceTokens: number, level: number): number {
    const ratios: Record<number, number> = { 1: 0.7, 2: 0.2, 3: 0.05 };
    return Math.max(50, Math.round(sourceTokens * (ratios[level] ?? 0.2)));
  }

  private buildCompactionPrompt(content: string, level: number, sourceCount: number): string {
    const levelDescriptions: Record<number, string> = {
      1: 'Create a near-verbatim summary preserving all key details, decisions, and facts. Reduce tokens by ~30%.',
      2: 'Create a condensed summary of only the essential facts, decisions, and outcomes. Reduce tokens by ~80%.',
      3: 'Create an ultra-compact summary of only the most critical facts. Use bullet points. Reduce tokens by ~95%.',
    };

    return `You are compacting ${sourceCount} memory records into a level ${level} summary.

Instructions: ${levelDescriptions[level]}

Content to compact:
---
${content}
---

Output only the summary, no commentary.`;
  }

  private inferEntityType(predicate: string): string {
    const map: Record<string, string> = {
      works_on: 'project', decided: 'decision', prefers: 'preference',
      learned: 'lesson', completed: 'event', failed: 'event',
      succeeded: 'event', recommended: 'advice', rejected: 'decision',
    };
    return map[predicate] ?? 'topic';
  }

  static format(node: CompactionNode): string {
    return [
      `[Level ${node.level}] ${node.id}`,
      `Compression: ${Math.round((1 - node.compression_ratio) * 100)}% (${node.token_count} tokens)`,
      `Sources: ${node.source_ids.length}`,
      `Accesses: ${node.access_count}`,
      '',
      node.content,
    ].join('\n');
  }
}

// ─── LLM Compiler Interface ──────────────────────────────────────────────────

export interface LLMCompiler {
  compile(prompt: string, maxTokens: number): Promise<string>;
}

export class RuleBasedCompiler implements LLMCompiler {
  async compile(prompt: string, maxTokens: number): Promise<string> {
    const match = prompt.match(/---\n([\s\S]+?)\n---/);
    if (!match) return prompt.substring(0, maxTokens * 4);

    const content = match[1];
    const lines = content.split('\n').filter((l: string) => l.trim());

    const important = lines.filter((l: string) => {
      const lower = l.toLowerCase();
      return /decided|learned|discovered|preference|important|critical|key/i.test(lower);
    });

    if (important.length > 0) {
      return important.join('\n').substring(0, maxTokens * 4);
    }

    return lines.slice(0, Math.ceil(lines.length * 0.3)).join('\n');
  }
}
