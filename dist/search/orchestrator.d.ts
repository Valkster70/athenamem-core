/**
 * AthenaMem Core Search Orchestrator
 *
 * When a recall request comes in, this fires queries across all active systems
 * in parallel, then fuses results using Reciprocal Rank Fusion (RRF).
 *
 * Systems queried:
 * - qmd: BM25 + vector hybrid search across workspace files
 * - ClawVault: Structured memory files (decisions/, lessons/, people/, etc.)
 * - Hindsight: Long-term fact extraction and recall
 * - Mnemo Cortex: Context retrieval and reasoning
 * - AthenaMem KG: Entity relations and temporal facts
 *
 * Results are fused, deduplicated, and optionally reranked by LLM.
 */
import { KnowledgeGraph } from '../core/kg.js';
import { Palace } from '../core/palace.js';
export interface SearchResult {
    id: string;
    content: string;
    source: SearchSource;
    source_name: string;
    score: number;
    sourceScores?: Record<string, number>;
    salience?: number;
    valid?: boolean;
    contradicted?: boolean;
    rank?: number;
    module?: string;
    section?: string;
    memory_type?: string;
    access_count?: number;
    timestamp?: number;
    url?: string;
    entry_id?: string;
    extractedFrom?: string;
    contradictionWith?: string[];
}
export type SearchSource = 'qmd' | 'clawvault' | 'hindsight' | 'mnemo' | 'kg' | 'athenamem';
export interface SearchOptions {
    query: string;
    module?: string;
    section?: string;
    wing?: string;
    room?: string;
    sources?: SearchSource[];
    limit?: number;
    fuseK?: number;
    minScore?: number;
    includeArchived?: boolean;
}
export interface SearchResponse {
    results: SearchResult[];
    query: string;
    sources_queried: SearchSource[];
    sources_with_results: SearchSource[];
    total_results: number;
    fused_in_ms: number;
    details: {
        [key in SearchSource]?: {
            results_count: number;
            query_ms: number;
            error?: string;
        };
    };
}
export declare class SearchOrchestrator {
    private kg;
    private palace;
    private qmdPath;
    private clawvaultPath;
    private hindsightUrl;
    private mnemoUrl;
    constructor(kg: KnowledgeGraph, palace: Palace, opts?: {
        qmdPath?: string;
        clawvaultPath?: string;
        hindsightUrl?: string;
        mnemoUrl?: string;
    });
    /**
     * Fire a query across all configured systems and fuse results.
     */
    search(options: SearchOptions): Promise<SearchResponse>;
    private querySystem;
    private queryQmd;
    private queryClawVault;
    private queryHindsight;
    private queryMnemo;
    private queryKG;
    private collectFiles;
    private safeReadText;
    private toRankedMap;
    private tokenizeQuery;
    private computeLexicalBoost;
    private computeLexicalStats;
    private findResultById;
    /**
     * Quick search — just fires qmd + KG, skips slower systems.
     * Use for real-time autocomplete and quick lookups.
     */
    quickSearch(query: string, limit?: number): Promise<SearchResult[]>;
    /**
     * Deep search — all systems, high limit, lower min score.
     * Use for research and exploration.
     */
    deepSearch(query: string, limit?: number): Promise<SearchResponse>;
}
export declare function formatSearchResults(response: SearchResponse): string;
//# sourceMappingURL=orchestrator.d.ts.map