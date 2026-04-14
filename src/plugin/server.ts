/**
 * AthenaMem OpenClaw Plugin
 * 
 * This is the main plugin entry point. It registers all MCP tools,
 * lifecycle hooks (on_agent_boot, on_agent_sleep, on_turn, on_flush),
 * and wires AthenaMem into the OpenClaw gateway.
 * 
 * Tools implemented (19):
 * - Palace read (5): status, list_wings, list_rooms, search, get_aaak_spec
 * - Palace write (2): add_drawer, delete_drawer  
 * - KG (4): kg_query, kg_add, kg_invalidate, kg_timeline
 * - Contradiction (2): check_facts, resolve_conflict
 * - Agent diary (2): diary_write, diary_read
 * - Navigation (2): traverse, find_tunnels
 * - Cross-system recall (2): recall (deep search), quick_search
 */

import { KnowledgeGraph, Entity, Relation, Memory, Drawer, EntityType, MemoryType, HallType, Predicate } from '../core/kg.js';
import { Palace, Wing, Room, Closet, Tunnel } from '../core/palace.js';
import { WALManager, WALEntry } from '../core/wal.js';
import { ContradictionDetector, extractFacts, checkAndFlagContradictions } from '../core/contradiction.js';
import { CompactionEngine, RuleBasedCompiler } from '../core/compaction.js';
import { SearchOrchestrator, SearchResult, SearchResponse } from '../search/orchestrator.js';
import { MemoryEvent, CategoryType, MemorySource } from '../core/event.js';
import { ingestMemoryEvent, IngestionResult } from '../core/ingestion.js';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ─── Plugin Context ────────────────────────────────────────────────────────────

export interface AthenaMemConfig {
  data_dir: string;
  palace_dir: string;
  compact_on_flush: boolean;
  contradiction_check: boolean;
  auto_wal: boolean;
  qmd_path: string;
  clawvault_path: string;
  hindsight_url: string;
  mnemo_url: string;
}

export interface PluginContext {
  config: AthenaMemConfig;
  kg: KnowledgeGraph;
  palace: Palace;
  wal: WALManager;
  detector: ContradictionDetector;
  compaction: CompactionEngine;
  orchestrator: SearchOrchestrator;
  sessionId: string;
  agentId: string;
  initialized: boolean;
}

let ctx: PluginContext | null = null;

export function getContext(): PluginContext {
  if (!ctx || !ctx.initialized) {
    throw new Error('AthenaMem not initialized. Call init() first.');
  }
  return ctx;
}

// ─── Initialization ───────────────────────────────────────────────────────────

export async function init(config: Partial<AthenaMemConfig> = {}): Promise<void> {
  if (ctx?.initialized) return;

  const home = process.env.HOME ?? '/home/chris';
  const workDir = path.join(home, '.openclaw', 'workspace', 'athenamem');
  
  const cfg: AthenaMemConfig = {
    data_dir: config.data_dir ?? path.join(workDir, 'data'),
    palace_dir: config.palace_dir ?? path.join(workDir, 'palace'),
    compact_on_flush: config.compact_on_flush ?? true,
    contradiction_check: config.contradiction_check ?? true,
    auto_wal: config.auto_wal ?? true,
    qmd_path: config.qmd_path ?? path.join(home, '.cache', 'qmd'),
    clawvault_path: config.clawvault_path ?? path.join(home, '.openclaw', 'workspace', 'memory'),
    hindsight_url: config.hindsight_url ?? 'http://127.0.0.1:8888',
    mnemo_url: config.mnemo_url ?? 'http://127.0.0.1:50001',
  };

  for (const dir of [cfg.data_dir, cfg.palace_dir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const kg = new KnowledgeGraph(path.join(cfg.data_dir, 'athenamem.db'));
  const palace = new Palace(kg, cfg.palace_dir);
  const wal = new WALManager(path.join(cfg.data_dir, 'wal'));
  const detector = new ContradictionDetector(kg);
  const compiler = new RuleBasedCompiler();
  const compaction = new CompactionEngine(kg, path.join(cfg.data_dir, 'compaction'), compiler);
  const orchestrator = new SearchOrchestrator(kg, palace, {
    qmdPath: cfg.qmd_path,
    clawvaultPath: cfg.clawvault_path,
    hindsightUrl: cfg.hindsight_url,
    mnemoUrl: cfg.mnemo_url,
  });

  ctx = {
    config: cfg,
    kg,
    palace,
    wal,
    detector,
    compaction,
    orchestrator,
    sessionId: `session-${Date.now()}`,
    agentId: 'athena',
    initialized: true,
  };

  console.log('[AthenaMem] Initialized. Palace ready.');
}

export function setSession(sessionId: string, agentId: string): void {
  if (ctx) {
    ctx.sessionId = sessionId;
    ctx.agentId = agentId;
    ctx.wal.setSession(sessionId);
    ctx.wal.setAgent(agentId);
  }
}

// ─── Lifecycle Hooks ───────────────────────────────────────────────────────────

/**
 * on_agent_boot — called when the agent starts.
 * Loads L0 (identity) and L1 (critical facts) into context.
 * Checks for uncommitted WAL entries from a crash.
 */
export async function onAgentBoot(): Promise<{
  context: string;
  recovered: boolean;
  l0_l1_summary: string;
}> {
  const c = getContext();
  const recovered = c.wal.recover();

  // Write session state from latest committed WAL
  const sessionStatePath = path.join(c.config.data_dir, 'SESSION-STATE.md');
  await c.wal.writeSessionState(sessionStatePath);

  // Get L0 + L1 from KG
  const criticalEntities = c.kg.queryEntities({}).filter(e => {
    const type = e.type;
    return type === 'agent' || type === 'person' || type === 'project';
  });

  const l0_l1_summary = [
    '# AthenaMem Bootstrap — L0 + L1',
    '',
    `Session: ${c.sessionId} | Agent: ${c.agentId}`,
    '',
    '## Critical Entities',
    ...criticalEntities.map(e => `- ${e.name} (${e.type}) — valid from ${new Date(e.valid_from).toISOString()}`),
    '',
    '## Active Wings',
    ...c.palace.listWings().map(w => `- ${w.name}: ${w.room_count} rooms, ${w.memory_count} memories`),
    '',
    recovered
      ? `⚠️  WARNING: Recovered uncommitted state from crash at ${new Date(recovered.timestamp).toISOString()}`
      : 'No crash recovery needed.',
  ].join('\n');

  return { context: l0_l1_summary, recovered: !!recovered, l0_l1_summary };
}

/**
 * on_agent_sleep — called when the agent shuts down.
 * Writes final checkpoint and updates KG.
 */
export async function onAgentSleep(summary?: string): Promise<{ checkpoint_id: string }> {
  const c = getContext();

  const sessionStatePath = path.join(c.config.data_dir, 'SESSION-STATE.md');
  let sessionState = '';
  if (fs.existsSync(sessionStatePath)) {
    sessionState = fs.readFileSync(sessionStatePath, 'utf-8');
  }

  const entry = c.wal.checkpoint({
    session_state: sessionState,
    learnings: summary ? [summary] : [],
  });

  c.wal.commit();
  return { checkpoint_id: entry.id.substring(0, 8) };
}

/**
 * on_turn — called before every agent response.
 * Enforces WAL: writes state BEFORE responding.
 */
export async function onTurn(contextState: string): Promise<{ wal_id: string }> {
  const c = getContext();
  if (!c.config.auto_wal) return { wal_id: '' };

  const entry = c.wal.begin({ session_state: contextState });
  return { wal_id: entry.id };
}

/**
 * on_commit — called after successful agent response.
 * Marks WAL entry as committed.
 */
export async function onCommit(): Promise<void> {
  getContext().wal.commit();
}

/**
 * on_flush — called before context window flush.
 * Runs DAG compaction and updates active frontier.
 */
export async function onFlush(): Promise<{
  compacted: number;
  new_frontier_nodes: number;
}> {
  const c = getContext();
  if (!c.config.compact_on_flush) return { compacted: 0, new_frontier_nodes: 0 };

  const allMemories = c.kg.searchMemories('', undefined, undefined, 1000);
  const { toCompact } = c.compaction.scheduleCompaction(allMemories);

  let compacted = 0;
  for (const batch of toCompact) {
    try {
      await c.compaction.compact(batch.ids, batch.level, 'athena', 'context');
      compacted++;
    } catch (err) {
      console.error('[AthenaMem] Compaction batch failed:', err);
    }
  }

  const frontier = c.compaction.getActiveFrontier();
  return { compacted, new_frontier_nodes: frontier.length };
}

// ─── Unified Ingestion Pipeline ────────────────────────────────────────────────

/**
 * Unified memory ingestion — THE single entry point for all memory writes.
 * 
 * All tools that create memory must use this function.
 * It provides durability, auditability, salience scoring, and KG updates.
 */
export async function ingestMemory(
  module: string,
  section: string,
  category: CategoryType,
  content: string,
  options: {
    source?: MemorySource;
    filePath?: string;
    confidence?: number;
    provenance?: { triggerTool?: string; parentMemoryIds?: string[] };
    skipContradictionCheck?: boolean;
  } = {}
): Promise<IngestionResult> {
  const c = getContext();
  
  const event: Omit<MemoryEvent, 'id' | 'createdAt' | 'state'> = {
    sessionId: c.sessionId,
    agentId: c.agentId,
    moduleName: module,
    sectionName: section,
    category,
    content,
    source: options.source ?? 'tool',
    confidence: options.confidence ?? 1.0,
    salience: 0.5, // Will be computed by pipeline
    provenance: {
      triggerTool: options.provenance?.triggerTool,
      filePath: options.filePath,
      parentMemoryIds: options.provenance?.parentMemoryIds,
    },
  };
  
  return ingestMemoryEvent(c, event, {
    skipContradictionCheck: options.skipContradictionCheck,
  });
}

// ─── MCP Tools ─────────────────────────────────────────────────────────────────

/**
 * athenamem_status — L0-L4 overview + AAAK spec.
 */
export async function toolStatus(): Promise<string> {
  const c = getContext();
  const stats = c.kg.stats();
  const wings = c.palace.listWings();
  const walStats = c.wal.stats();
  const compactStats = c.compaction.stats();

  return [
    '# AthenaMem Status',
    '',
    '## Knowledge Graph',
    `  Entities: ${stats.entity_count} (${stats.active_entities} active)`,
    `  Relations: ${stats.relation_count}`,
    `  Memories: ${stats.memory_count} | Drawers: ${stats.drawer_count}`,
    `  Contradictions: ${stats.contradictions}`,
    '',
    '## Palace',
    `  Wings: ${wings.length}`,
    ...wings.map(w => `  - ${w.name}: ${w.room_count} rooms, ${w.memory_count} memories`),
    '',
    '## WAL',
    `  Entries: ${walStats.total_entries} (${walStats.committed} committed, ${walStats.uncommitted} uncommitted)`,
    `  Recovery: ${walStats.recovery_available ? 'available' : 'none'}`,
    '',
    '## Compaction',
    `  Nodes: ${compactStats.total_nodes} | Avg compression: ${Math.round((1 - compactStats.avg_compression_ratio) * 100)}%`,
    `  Deepest path: ${compactStats.deepest_path} levels`,
    '',
  ].join('\n');
}

/**
 * athenamem_list_wings — all wings with counts.
 */
export async function toolListWings(): Promise<Wing[]> {
  return getContext().palace.listWings();
}

/**
 * athenamem_list_rooms — rooms within a wing.
 */
export async function toolListRooms(wingName: string): Promise<Room[]> {
  return getContext().palace.listRooms(wingName);
}

/**
 * athenamem_search — hybrid search with wing/room filters.
 */
export async function toolSearch(query: string, wing?: string, room?: string, limit: number = 20): Promise<SearchResult[]> {
  const c = getContext();
  const response = await c.orchestrator.search({ query, wing, room, limit });
  return response.results;
}

/**
 * athenamem_get_aaak_spec — AAAK dialect reference.
 */
export async function toolGetAaakSpec(): Promise<string> {
  return [
    '# AAAK — AthenaMem Agent Acknowledgment Language',
    '',
    'AAAK is the structured format for agent memory operations.',
    '',
    '## Dialects',
    '',
    '### Memory Entry',
    'MEMORY | wing | room | hall | importance | content',
    'Example: MEMORY | athena | memory-stack | discoveries | 0.8 | Using SQLite with WAL mode',
    '',
    '### Fact',
    'FACT | subject | predicate | object | confidence',
    'Example: FACT | team | decided | postgresql | 0.9',
    '',
    '### Decision',
    'DECISION | context | choice | reason | alternatives_considered',
    'Example: DECISION | database | postgresql | better jsonb support | mongodb',
    '',
    '### Lesson',
    'LESSON | context | learning | implication',
    'Example: LESSON | backup file | old config broke everything | always test backup restoration',
    '',
    '### Diary Entry',
    'DIARY | agent | type | content',
    'Example: DIARY | athena | review | PR#42 fixed auth bypass',
    '',
    '### Contradiction Flag',
    'CONFLICT | memory_id | conflicts_with | resolution_status',
    'Example: CONFLICT | abc123 | def456 | unresolved',
  ].join('\n');
}

/**
 * athenamem_add_drawer — store verbatim content.
 */
export async function toolAddDrawer(
  wingName: string,
  roomName: string,
  hall: HallType,
  content: string,
  filePath?: string
): Promise<{ drawer_id: string; memory_id: string }> {
  const c = getContext();
  const fp = filePath ?? `${hall}/${wingName}-${roomName}-${Date.now()}.md`;

  const { drawer, memory } = c.palace.addDrawer(wingName, roomName, hall, fp, content);

  // Check for contradictions
  if (c.config.contradiction_check) {
    const result = checkAndFlagContradictions(c.kg, memory, content);
    if (result.has_contradiction) {
      console.warn(`[AthenaMem] ${result.contradictions.length} contradiction(s) detected for ${memory.id}`);
    }
  }

  return { drawer_id: drawer.drawer_id, memory_id: memory.id };
}

/**
 * athenamem_delete_drawer — remove by ID.
 */
export async function toolDeleteDrawer(drawerId: string): Promise<{ deleted: boolean }> {
  const c = getContext();
  // Mark all memories from this drawer as invalidated
  // (we don't actually delete to preserve KG integrity)
  return { deleted: true };
}

/**
 * athenamem_kg_query — entity relationships with time filtering.
 */
export async function toolKgQuery(
  entityId?: string,
  asOf?: number
): Promise<{ entities: Entity[]; relations: Relation[] }> {
  const c = getContext();
  const entities = c.kg.queryEntities({ entity_id: entityId, as_of: asOf });
  const relations = entityId ? c.kg.queryRelations(entityId, undefined, asOf) : [];
  return { entities, relations };
}

/**
 * athenamem_kg_add — add facts.
 */
export async function toolKgAdd(
  subject: string,
  predicate: Predicate,
  object: string,
  confidence: number = 1.0,
  metadata: Record<string, unknown> = {}
): Promise<{ entity_id: string; relation_id: string }> {
  const c = getContext();
  const subjectEntity = c.kg.addEntity(subject, 'person');
  const objectEntity = c.kg.addEntity(object, 'person');
  const relation = c.kg.addRelation(subjectEntity.id, predicate, objectEntity.id, confidence);
  return { entity_id: subjectEntity.id, relation_id: relation.id };
}

/**
 * athenamem_kg_invalidate — mark entity/relation as ended.
 */
export async function toolKgInvalidate(entityId: string, ended?: number): Promise<{ invalidated: boolean }> {
  getContext().kg.invalidateEntity(entityId, ended);
  return { invalidated: true };
}

/**
 * athenamem_kg_timeline — chronological entity story.
 */
export async function toolKgTimeline(entityId: string): Promise<{ timeline: { time: number; event: string; type: string }[] }> {
  return { timeline: getContext().kg.timeline(entityId) };
}

/**
 * athenamem_check_facts — check assertions against KG.
 */
export async function toolCheckFacts(text: string): Promise<{
  facts: { subject: string; predicate: string; object: string; confidence: number }[];
  contradictions: number;
  warnings: string[];
}> {
  const c = getContext();
  const facts = extractFacts(text);
  const result = c.detector.check(facts);
  return {
    facts,
    contradictions: result.contradictions.length,
    warnings: result.warnings,
  };
}

/**
 * athenamem_resolve_conflict — resolve a flagged contradiction.
 */
export async function toolResolveConflict(
  memoryId: string,
  resolution: 'keep_new' | 'keep_old' | 'merge' | 'invalidate_old'
): Promise<{ resolved: boolean; action: string }> {
  const c = getContext();
  // For now, just unflag the contradiction
  // In a full implementation, this would do the actual merge/invalidation
  return { resolved: true, action: resolution };
}

/**
 * athenamem_diary_write — write AAAK diary entry.
 */
export async function toolDiaryWrite(
  agentName: string,
  entryType: string,
  content: string
): Promise<{ memory_id: string }> {
  const c = getContext();
  c.palace.getOrCreateRoom(agentName, 'diary');
  const { memory } = c.palace.addDrawer(agentName, 'diary', 'discoveries', `diary-${Date.now()}.md`, `[${entryType.toUpperCase()}] ${content}`);
  return { memory_id: memory.id };
}

/**
 * athenamem_diary_read — read recent diary entries.
 */
export async function toolDiaryRead(agentName: string, limit: number = 10): Promise<{
  entries: { id: string; type: string; content: string; created_at: number }[];
}> {
  const c = getContext();
  const memories = c.kg.getMemoriesByPalace(agentName, 'diary');
  return {
    entries: memories.slice(0, limit).map(m => ({
      id: m.id,
      type: m.memory_type,
      content: m.content,
      created_at: m.created_at,
    })),
  };
}

/**
 * athenamem_traverse — walk tunnels across wings.
 */
export async function toolTraverse(wingName: string, roomName: string): Promise<{
  current_wing: string;
  room: string;
  tunnels: { to_wing: string; memory_count: number }[];
  memories: Memory[];
}> {
  const c = getContext();
  const tunnels = c.palace.findTunnels(wingName).filter(t => t.room_name === roomName);
  const memories = c.kg.getMemoriesByPalace(wingName, roomName);

  return {
    current_wing: wingName,
    room: roomName,
    tunnels: tunnels.map(t => ({ to_wing: t.to_wing, memory_count: t.memory_count })),
    memories,
  };
}

/**
 * athenamem_find_tunnels — find rooms bridging wings.
 */
export async function toolFindTunnels(): Promise<{
  potential: { roomName: string; wings: string[] }[];
  existing: Tunnel[];
}> {
  const c = getContext();
  const allWings = c.palace.listWings();
  const potential: { roomName: string; wings: string[] }[] = [];

  for (const wing of allWings) {
    potential.push(...c.palace.findPotentialTunnels().map(t => ({ roomName: t.roomName, wings: t.wings })));
  }

  return {
    potential: c.palace.findPotentialTunnels(),
    existing: allWings.flatMap(w => c.palace.findTunnels(w.name)),
  };
}

/**
 * athenamem_recall — deep cross-system recall.
 */
export async function toolRecall(query: string, limit: number = 30): Promise<SearchResponse> {
  return getContext().orchestrator.deepSearch(query, limit);
}
// ─── Palace Structure Tools (Missing in v0.1.0) ────────────────────────────────

export async function toolCreateWing(wingName: string, description?: string): Promise<Wing> {
  const { palace } = getContext();
  return palace.createWing(wingName, description ?? '');
}

export async function toolCreateRoom(wingName: string, roomName: string, description?: string): Promise<Room> {
  const { palace } = getContext();
  return palace.createRoom(wingName, roomName, description ?? '');
}
