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

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { KnowledgeGraph } from '../core/kg.js';
import { Palace } from '../core/palace.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  id: string;
  content: string;
  source: SearchSource;
  source_name: string;      // e.g., "qmd", "ClawVault/decisions"
  score: number;           // 0-1, fused score
  
  // Explainability fields
  sourceScores?: Record<string, number>;  // Per-source contribution: { qmd: 0.85, kg: 0.72, ... }
  salience?: number;       // Memory salience score (0-1)
  valid?: boolean;         // false if invalidated
  contradicted?: boolean;  // true if in conflict
  
  // Metadata
  rank?: number;
  module?: string;
  section?: string;
  memory_type?: string;
  access_count?: number;
  timestamp?: number;
  url?: string;
  entry_id?: string;
  
  // Provenance
  extractedFrom?: string;  // parent memory ID
  contradictionWith?: string[]; // conflicting memory IDs
}

export type SearchSource = 'qmd' | 'clawvault' | 'hindsight' | 'mnemo' | 'kg' | 'athenamem';

export interface SearchOptions {
  query: string;
  module?: string; // internal canonical filter
  section?: string; // internal canonical filter
  wing?: string; // external alias for module
  room?: string; // external alias for section
  sources?: SearchSource[]; // which systems to query (default: all)
  limit?: number; // max results (default: 20)
  fuseK?: number; // RRF k parameter (default: 60)
  minScore?: number; // minimum fused score (default: 0.1)
  includeArchived?: boolean; // include cold/archival storage
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

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion (RRF) — combines rankings from multiple retrieval systems.
 * 
 * RRF score for a document d:
 *   RRF(d) = Σ 1/(k + rank_i(d))
 * 
 * where:
 *   k = 60 (standard constant)
 *   rank_i(d) = rank of document d in the i-th result list (1-indexed)
 *   Documents not in a list get rank = ∞ and contribute 0
 */
function reciprocalRankFusion(
  rankedLists: Map<string, { source: SearchSource; rank: number; score: number; result: SearchResult }>[],
  k: number = 60
): Map<string, number> {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    for (const [id, entry] of list) {
      const existing = scores.get(id) ?? 0;
      scores.set(id, existing + 1 / (k + entry.rank));
    }
  }

  return scores;
}

// ─── SearchOrchestrator Class ─────────────────────────────────────────────────

export class SearchOrchestrator {
  private kg: KnowledgeGraph;
  private palace: Palace;
  private qmdPath: string;
  private clawvaultPath: string;
  private hindsightUrl: string;
  private mnemoUrl: string;

  constructor(
    kg: KnowledgeGraph,
    palace: Palace,
    opts: {
      qmdPath?: string;
      clawvaultPath?: string;
      hindsightUrl?: string;
      mnemoUrl?: string;
    } = {}
  ) {
    const home = process.env.HOME ?? homedir();
    this.kg = kg;
    this.palace = palace;
    this.qmdPath = opts.qmdPath ?? path.join(home, '.cache', 'qmd');
    this.clawvaultPath = opts.clawvaultPath ?? path.join(home, '.openclaw', 'workspace', 'memory');
    this.hindsightUrl = opts.hindsightUrl ?? 'http://127.0.0.1:8888';
    this.mnemoUrl = opts.mnemoUrl ?? 'http://127.0.0.1:50001';
  }

  // ─── Main Search ───────────────────────────────────────────────────────────

  /**
   * Fire a query across all configured systems and fuse results.
   */
  async search(options: SearchOptions): Promise<SearchResponse> {
    const start = Date.now();
    const {
      query,
      module,
      section,
      wing,
      room,
      sources,
      limit = 20,
      fuseK = 60,
      minScore = 0.01,
    } = options;

    const normalizedModule = wing ?? module;
    const normalizedSection = room ?? section;

    const allSources: SearchSource[] = sources ?? ['qmd', 'clawvault', 'hindsight', 'mnemo', 'kg'];
    const details: SearchResponse['details'] = {};

    // Fire all system queries in parallel
    const queries: Promise<SearchResult[]>[] = [];
    const sourceMap: SearchSource[] = [];

    for (const source of allSources) {
      queries.push(this.querySystem(source, query, normalizedModule, normalizedSection, limit));
      sourceMap.push(source);
    }

    const results = await Promise.allSettled(queries);
    const rankedLists: Map<string, { source: SearchSource; rank: number; score: number; result: SearchResult }>[] = [];
    const sourcesWithResults: SearchSource[] = [];

    for (let i = 0; i < results.length; i++) {
      const source = sourceMap[i];
      const outcome = results[i];

      if (outcome.status === 'fulfilled') {
        const res = outcome.value;
        details[source] = { results_count: res.length, query_ms: 0 };
        if (res.length > 0) sourcesWithResults.push(source);
        rankedLists.push(this.toRankedMap(res));
      } else {
        details[source] = { results_count: 0, query_ms: 0, error: String(outcome.reason) };
      }
    }

    // Fuse rankings
    const fused = reciprocalRankFusion(rankedLists, fuseK);

    // Build final results
    const allResults: SearchResult[] = [];
    for (const [id, score] of fused) {
      if (score < minScore) continue;

      // Find the best-scoring result for this ID across all systems
      const res = this.findResultById(rankedLists, id);
      if (res) {
        const lexicalText = `${res.content}\n${res.source_name}`;
        const lexical = this.computeLexicalStats(query, lexicalText);
        const requiresLexicalGate = res.source === 'qmd' || res.source === 'clawvault' || res.source === 'kg';
        if (requiresLexicalGate && !lexical.passesThreshold) continue;
        const scoreBoost = requiresLexicalGate ? lexical.boost : Math.max(1, lexical.boost);
        res.score = score * scoreBoost;
        allResults.push(res);
      }
    }

    // Sort by fused score, apply limit
    allResults.sort((a, b) => b.score - a.score);
    const finalResults = allResults.slice(0, limit);

    // Assign final ranks
    for (let i = 0; i < finalResults.length; i++) {
      finalResults[i].rank = i + 1;
    }

    return {
      results: finalResults,
      query,
      sources_queried: allSources,
      sources_with_results: sourcesWithResults,
      total_results: finalResults.length,
      fused_in_ms: Date.now() - start,
      details,
    };
  }

  // ─── Per-System Queries ─────────────────────────────────────────────────────

  private async querySystem(
    source: SearchSource,
    query: string,
    module?: string,
    section?: string,
    limit: number = 20
  ): Promise<SearchResult[]> {
    switch (source) {
      case 'qmd':
        return this.queryQmd(query, limit);
      case 'clawvault':
        return this.queryClawVault(query, module, section, limit);
      case 'hindsight':
        return this.queryHindsight(query, limit);
      case 'mnemo':
        return this.queryMnemo(query, limit);
      case 'kg':
        return this.queryKG(query, module, section, limit);
      default:
        return [];
    }
  }

  private async queryQmd(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const child = spawnSync('qmd', ['search', query, '--limit', String(limit)], {
        encoding: 'utf-8',
        timeout: 10000,
        shell: false,
      });

      if (child.error || child.status !== 0) return [];

      const output = child.stdout ?? '';
      const results: SearchResult[] = [];
      const lines: string[] = output.split('\n').filter((l: string) => l.trim());

      // Parse qmd output format (file:score:content)
      for (const line of lines) {
        const match = line.match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/);
        if (match) {
          const [, file, scoreStr, content] = match;
          results.push({
            id: `qmd:${file}`,
            content: content.trim(),
            source: 'qmd',
            source_name: `qmd:${file}`,
            score: parseFloat(scoreStr) || 0.5,
            url: file,
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  private async queryClawVault(
    query: string,
    module?: string,
    section?: string,
    limit: number = 20
  ): Promise<SearchResult[]> {
    let basePath = this.clawvaultPath;
    if (module) {
      basePath = path.join(basePath, module);
      if (section) {
        basePath = path.join(basePath, section);
      }
    }

    if (!fs.existsSync(basePath)) {
      return [];
    }

    const normalizedQuery = query.toLowerCase();
    const tokens = this.tokenizeQuery(query);
    const results: SearchResult[] = [];
    const files = this.collectFiles(basePath);

    for (const file of files) {
      const content = this.safeReadText(file);
      if (content == null) continue;

      const lower = content.toLowerCase();
      const matchCount = tokens.filter(token => lower.includes(token)).length;
      const wholeQueryMatch = lower.includes(normalizedQuery);
      if (!wholeQueryMatch && matchCount === 0) continue;

      const relative = path.relative(this.clawvaultPath, file);
      const parts = relative.split(path.sep).filter(Boolean);
      if (module && parts[0] !== module) continue;
      if (section && parts[1] !== section) continue;

      results.push({
        id: `clawvault:${file}`,
        content: content.length > 300 ? `${content.slice(0, 300)}...` : content,
        source: 'clawvault',
        source_name: `ClawVault/${parts.slice(0, 2).join('/')}`,
        score: this.computeLexicalBoost(query, `${relative}\n${content}`),
        module: parts[0],
        section: parts[1],
        url: file,
      });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private async queryHindsight(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const response = await fetch(`${this.hindsightUrl}/recall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return [];

      const data = await response.json() as { results?: { id?: string; content?: string; score?: number }[] };
      if (!data.results) return [];

      return data.results.slice(0, limit).map((r, i) => ({
        id: `hindsight:${r.id ?? i}`,
        content: r.content ?? '',
        source: 'hindsight' as SearchSource,
        source_name: 'Hindsight',
        score: r.score ?? 0.5,
      }));
    } catch {
      return [];
    }
  }

  private async queryMnemo(query: string, limit: number): Promise<SearchResult[]> {
    try {
      const response = await fetch(`${this.mnemoUrl}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) return [];

      const data = await response.json() as { context?: { id?: string; text?: string; relevance?: number }[] };
      if (!data.context) return [];

      return data.context.slice(0, limit).map((r, i) => ({
        id: `mnemo:${r.id ?? i}`,
        content: r.text ?? '',
        source: 'mnemo' as SearchSource,
        source_name: 'Mnemo Cortex',
        score: r.relevance ?? 0.5,
      }));
    } catch {
      return [];
    }
  }

  private async queryKG(
    query: string,
    module?: string,
    section?: string,
    limit: number = 20
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // KG search uses FTS/LIKE on memories
    const memories = this.kg.searchMemories(query, module, section, limit);
    results.push(...memories.map(m => ({
      id: `kg:${m.id}`,
      content: m.content,
      source: 'kg' as SearchSource,
      source_name: `AthenaMem KG/${m.module}/${m.section}`,
      score: this.computeLexicalBoost(query, m.content),
      module: m.module,
      section: m.section,
      memory_type: m.memory_type,
      access_count: m.access_count,
      timestamp: m.created_at,
      entry_id: m.entry_id,
    })));

    // Also search actual entity and relation facts, not just memory text.
    const tokens = this.tokenizeQuery(query);
    const seen = new Set(results.map(r => r.id));

    for (const token of tokens) {
      const entity = this.kg.getEntityByName(token);
      if (!entity) continue;

      const facts = this.kg.getEntityFacts(entity.id);
      for (const rel of facts.outgoing) {
        const object = this.kg.queryEntities({ entity_id: rel.object_id })[0];
        const factText = `${entity.name} ${rel.predicate} ${object?.name ?? rel.object_id}`;
        const id = `kgrel:${rel.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        results.push({
          id,
          content: factText,
          source: 'kg' as SearchSource,
          source_name: 'AthenaMem KG/fact',
          score: this.computeLexicalBoost(query, factText),
          timestamp: rel.created_at,
        });
      }

      for (const rel of facts.incoming) {
        const subject = this.kg.queryEntities({ entity_id: rel.subject_id })[0];
        const factText = `${subject?.name ?? rel.subject_id} ${rel.predicate} ${entity.name}`;
        const id = `kgrel:${rel.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        results.push({
          id,
          content: factText,
          source: 'kg' as SearchSource,
          source_name: 'AthenaMem KG/fact',
          score: this.computeLexicalBoost(query, factText),
          timestamp: rel.created_at,
        });
      }
    }

    return results
      .sort((a, b) => b.score - a.score || (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, limit);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private collectFiles(dir: string): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.collectFiles(fullPath));
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!['.md', '.txt', '.json', '.yaml', '.yml'].includes(ext)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.size > 1024 * 1024) continue;

      files.push(fullPath);
    }

    return files;
  }

  private safeReadText(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  }

  private toRankedMap(results: SearchResult[]): Map<string, { source: SearchSource; rank: number; score: number; result: SearchResult }> {
    const map = new Map<string, { source: SearchSource; rank: number; score: number; result: SearchResult }>();
    const ranked = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      map.set(r.id, { source: r.source, rank: i + 1, score: r.score ?? 0, result: r });
    }
    return map;
  }

  private tokenizeQuery(query: string): string[] {
    return Array.from(new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2)
    ));
  }

  private computeLexicalBoost(query: string, haystack: string): number {
    return this.computeLexicalStats(query, haystack).boost;
  }

  private computeLexicalStats(query: string, haystack: string): { boost: number; passesThreshold: boolean } {
    const text = haystack.toLowerCase();
    const tokens = this.tokenizeQuery(query);
    if (tokens.length === 0) return { boost: 1, passesThreshold: true };

    let matches = 0;
    for (const token of tokens) {
      if (text.includes(token)) matches += 1;
    }

    const coverage = matches / tokens.length;
    const fullQueryMatch = text.includes(query.toLowerCase()) ? 0.75 : 0;
    const passesThreshold = tokens.length <= 1 || fullQueryMatch > 0 || coverage >= 0.5;

    return {
      boost: 1 + coverage + fullQueryMatch,
      passesThreshold,
    };
  }

  private findResultById(rankedLists: Map<string, { source: SearchSource; rank: number; score: number; result: SearchResult }>[], id: string): SearchResult | null {
    for (const map of rankedLists) {
      const entry = map.get(id);
      if (entry) {
        return {
          ...entry.result,
          rank: entry.rank,
          score: entry.score,
        };
      }
    }
    return null;
  }

  /**
   * Quick search — just fires qmd + KG, skips slower systems.
   * Use for real-time autocomplete and quick lookups.
   */
  async quickSearch(query: string, limit: number = 10): Promise<SearchResult[]> {
    const response = await this.search({
      query,
      sources: ['qmd', 'kg'],
      limit,
      minScore: 0.01,
    });
    return response.results;
  }

  /**
   * Deep search — all systems, high limit, lower min score.
   * Use for research and exploration.
   */
  async deepSearch(query: string, limit: number = 50): Promise<SearchResponse> {
    return this.search({
      query,
      sources: ['qmd', 'clawvault', 'hindsight', 'mnemo', 'kg'],
      limit,
      fuseK: 60,
      minScore: 0.01,
    });
  }
}

// ─── Result Formatting ─────────────────────────────────────────────────────────

export function formatSearchResults(response: SearchResponse): string {
  const lines: string[] = [
    `# Search Results: "${response.query}"`,
    '',
    `Found ${response.total_results} results across ${response.sources_with_results.length} systems (${response.fused_in_ms}ms)`,
    '',
  ];

  const sourceColors: Record<string, string> = {
    qmd: '🔍',
    clawvault: '📁',
    hindsight: '🧠',
    mnemo: '💭',
    kg: '🔗',
  };

  for (const result of response.results) {
    const icon = sourceColors[result.source] ?? '•';
    const moduleSection = result.module ? `[${result.module}/${result.section ?? 'root'}] ` : '';
    lines.push(`${icon} **Rank #${result.rank}** — ${result.source_name} (score: ${result.score.toFixed(3)})`);
    lines.push(`   ${moduleSection}${result.content.substring(0, 200)}${result.content.length > 200 ? '...' : ''}`);
    lines.push('');
  }

  return lines.join('\n');
}
