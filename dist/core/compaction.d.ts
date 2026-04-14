/**
 * AthenaMem Compaction Engine — DAG-Based Memory Compression
 *
 * Inspired by Mnemo Cortex's insight: memories are stored as a DAG where each
 * node is a summary that traces back to verbatim leaf nodes (raw messages).
 */
import { KnowledgeGraph, Memory } from './kg.js';
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
export declare class CompactionEngine {
    private kg;
    private compactionDir;
    private nodes;
    private llm;
    constructor(kg: KnowledgeGraph, compactionDir: string, llm: LLMCompiler);
    private loadNodes;
    private saveNodes;
    compact(sourceIds: string[], level: 1 | 2 | 3, module: string, section: string): Promise<CompactionResult>;
    expand(nodeId: string, depth?: number, maxDepth?: number): {
        content: string;
        sources: {
            id: string;
            content: string;
            type: string;
        }[];
        depth: number;
    };
    getActiveFrontier(): CompactionNode[];
    /**
     * Schedule compaction with salience-aware policy.
     *
     * NEVER compact:
     * - Very high-salience items (salience >= 0.75)
     * - Unresolved contradictions
     * - Recent active project decisions
     *
     * PRIORITIZE compacting:
     * - Older low-access memories
     * - Repetitive discoveries
     * - Resolved/invalidated items
     */
    scheduleCompaction(memories: Memory[]): {
        toCompact: {
            ids: string[];
            level: 1 | 2 | 3;
        }[];
        stats: CompactionStats;
        policy: {
            protected_count: number;
            high_salience: number;
            contradictions: number;
            candidates: number;
        };
    };
    stats(): CompactionStats;
    private targetTokens;
    private buildCompactionPrompt;
    private inferEntityType;
    static format(node: CompactionNode): string;
}
export interface LLMCompiler {
    compile(prompt: string, maxTokens: number): Promise<string>;
}
export declare class RuleBasedCompiler implements LLMCompiler {
    compile(prompt: string, maxTokens: number): Promise<string>;
}
//# sourceMappingURL=compaction.d.ts.map