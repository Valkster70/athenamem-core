/**
 * AthenaMem CLI
 * 
 * Command-line interface for AthenaMem memory operations.
 * 
 * Usage:
 *   athenamem <command> [options]
 * 
 * Commands:
 *   init              Initialize AthenaMem workspace
 *   status            Show palace overview + system health
 *   wake              Load L0 + L1 context (for agent bootstrap)
 *   checkpoint        Save current state (WAL enforcement)
 *   sleep <summary>   End session, finalize
 *   remember          Store a new memory
 *   recall <query>    Search across all memory systems
 *   search <query>    Quick search (qmd + KG only)
 *   wings [list]      List or manage wings
 *   rooms <wing>      List rooms in a wing
 *   diary <agent>     Write/read agent diary
 *   audit             Check for contradictions
 *   compact           Run DAG compaction
 *   stats             Show KG statistics
 *   export            Export KG as JSON
 *   import <file>     Import KG from JSON
 *   tunnel <from> <to> <room>  Create cross-wing tunnel
 */

import { KnowledgeGraph } from '../core/kg.js';
import { Palace } from '../core/palace.js';
import { WALManager } from '../core/wal.js';
import { CompactionEngine } from '../core/compaction.js';
import { SearchOrchestrator, formatSearchResults } from '../search/orchestrator.js';
import * as fs from 'fs';
import * as path from 'path';

const VERSION = '0.1.0';

// ─── CLI Entry Point ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`AthenaMem v${VERSION} — The memory that learns.\n`);
  console.log('Usage: athenamem <command> [options]\n');
  console.log('Run "athenamem help <command>" for details.');
  process.exit(0);
}

const command = args[0];
const subargs = args.slice(1);

runCommand(command, subargs).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

// ─── Command Router ────────────────────────────────────────────────────────────

async function runCommand(cmd: string, args: string[]): Promise<void> {
  const home = process.env.HOME ?? '/home/chris';
  const workDir = path.join(home, '.openclaw', 'workspace', 'athenamem');
  const dataDir = path.join(workDir, 'data');
  const palaceDir = path.join(workDir, 'palace');

  // Ensure directories exist
  for (const dir of [workDir, dataDir, palaceDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const kg = new KnowledgeGraph(path.join(dataDir, 'athenamem.db'));
  const palace = new Palace(kg, palaceDir);
  const wal = new WALManager(path.join(dataDir, 'wal'));

  switch (cmd) {
    case 'help':
      return printHelp(args[0]);
    case 'init':
      return cmdInit(workDir, args);
    case 'status':
      return cmdStatus(kg, palace);
    case 'wake':
      return cmdWake(kg, palace, wal, workDir);
    case 'checkpoint':
      return cmdCheckpoint(kg, palace, wal, workDir, args);
    case 'sleep':
      return cmdSleep(kg, palace, wal, workDir, args);
    case 'remember':
      return cmdRemember(kg, palace, args);
    case 'recall':
      return cmdRecall(kg, palace, args);
    case 'search':
      return cmdSearch(kg, palace, args);
    case 'wings':
      return cmdWings(palace, args);
    case 'rooms':
      return cmdRooms(palace, args);
    case 'diary':
      return cmdDiary(palace, args);
    case 'audit':
      return cmdAudit(kg);
    case 'compact':
      return cmdCompact(kg, palace, workDir);
    case 'stats':
      return cmdStats(kg);
    case 'export':
      return cmdExport(kg, args);
    case 'import':
      return cmdImport(kg, args);
    case 'tunnel':
      return cmdTunnel(palace, args);
    case '--version':
    case 'version':
      return console.log(`AthenaMem v${VERSION}`);
    default:
      throw new Error(`Unknown command: ${cmd}. Run "athenamem help" for usage.`);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

function cmdInit(workDir: string, args: string[]): void {
  const name = args[0] ?? 'athenamem';
  console.log(`Initializing ${name} at ${workDir}...`);
  console.log('Done. Run "athenamem status" to verify.');
}

async function cmdStatus(kg: KnowledgeGraph, palace: Palace): Promise<void> {
  const stats = kg.stats();
  const wings = palace.listWings();
  const walStats = new WALManager(path.join(process.env.HOME ?? '', '.openclaw', 'workspace', 'athenamem', 'data', 'wal')).stats();

  console.log(`
# AthenaMem Palace Status
=========================

## Knowledge Graph
  Entities:   ${stats.entity_count} (${stats.active_entities} active)
  Relations:   ${stats.relation_count}
  Memories:    ${stats.memory_count}
  Drawers:     ${stats.drawer_count}
  Contradictions flagged: ${stats.contradictions}

## Palace Wings
  ${wings.length === 0 ? 'No wings created yet.' : ''}
${wings.map(w => `  ${w.name} (${w.room_count} rooms, ${w.memory_count} memories)`).join('\n')}

## WAL Status
  Total entries:  ${walStats.total_entries}
  Committed:     ${walStats.committed}
  Uncommitted:   ${walStats.uncommitted}
  Recovery:       ${walStats.recovery_available ? '✅ Available' : '❌ None'}
`);
}

async function cmdWake(kg: KnowledgeGraph, palace: Palace, wal: WALManager, workDir: string): Promise<void> {
  const sessionStatePath = path.join(workDir, 'SESSION-STATE.md');
  const recovered = wal.recover();

  if (recovered) {
    console.log('⚠️  Recovered uncommitted state from previous session:');
    console.log(JSON.stringify(recovered.data, null, 2));
  }

  const latest = await wal.writeSessionState(sessionStatePath);
  if (latest) {
    console.log(`✅ Wrote session state to ${sessionStatePath}`);
  } else {
    console.log('No previous state found — fresh session.');
  }
}

async function cmdCheckpoint(kg: KnowledgeGraph, palace: Palace, wal: WALManager, workDir: string, args: string[]): Promise<void> {
  const sessionStatePath = path.join(workDir, 'SESSION-STATE.md');
  let sessionState = '';
  if (fs.existsSync(sessionStatePath)) {
    sessionState = fs.readFileSync(sessionStatePath, 'utf-8');
  }

  const walEntry = wal.checkpoint({
    session_state: sessionState,
    decisions: [],
    tasks: [],
  });

  console.log(`✅ Checkpoint saved: ${walEntry.id.substring(0, 8)}...`);
}

async function cmdSleep(kg: KnowledgeGraph, palace: Palace, wal: WALManager, workDir: string, args: string[]): Promise<void> {
  const summary = args.join(' ') || 'Session ended.';
  const sessionStatePath = path.join(workDir, 'SESSION-STATE.md');

  let sessionState = '';
  if (fs.existsSync(sessionStatePath)) {
    sessionState = fs.readFileSync(sessionStatePath, 'utf-8');
  }

  wal.checkpoint({ session_state: sessionState, learnings: [summary] });
  console.log(`✅ Session ended. Summary: ${summary}`);
}

async function cmdRemember(kg: KnowledgeGraph, palace: Palace, args: string[]): Promise<void> {
  // Usage: remember <wing> <room> [--content "text"] [--hall facts|events|discoveries|preferences|advice]
  const wing = args[0];
  const room = args[1];
  if (!wing || !room) throw new Error('Usage: athenamem remember <wing> <room> [--content "text"]');

  const contentIdx = args.indexOf('--content');
  const hallIdx = args.indexOf('--hall');
  const content = contentIdx >= 0 ? args[contentIdx + 1] : '';
  const hall = (hallIdx >= 0 ? args[hallIdx + 1] : 'facts') as 'facts' | 'events' | 'discoveries' | 'preferences' | 'advice';

  if (!content) throw new Error('--content is required');

  const filePath = `${hall}/${wing}-${room}-${Date.now()}.md`;
  const { drawer, memory } = palace.addDrawer(wing, room, hall, filePath, content);

  console.log(`✅ Stored memory ${memory.id.substring(0, 8)}... in ${wing}/${room}/${hall}`);
  console.log(`   Drawer: ${drawer.drawer_id.substring(0, 8)}...`);
}

async function cmdRecall(kg: KnowledgeGraph, palace: Palace, args: string[]): Promise<void> {
  const query = args.join(' ');
  if (!query) throw new Error('Usage: athenamem recall <query>');

  const orchestrator = new SearchOrchestrator(kg, palace);
  const response = await orchestrator.deepSearch(query, 30);

  console.log(formatSearchResults(response));
}

async function cmdSearch(kg: KnowledgeGraph, palace: Palace, args: string[]): Promise<void> {
  const query = args.join(' ');
  if (!query) throw new Error('Usage: athenamem search <query>');

  const orchestrator = new SearchOrchestrator(kg, palace);
  const results = await orchestrator.quickSearch(query, 15);

  console.log(`# Quick Search: "${query}"\n`);
  for (const r of results) {
    console.log(`[${r.source_name}] ${r.content.substring(0, 150)}`);
    console.log('');
  }
}

async function cmdWings(palace: Palace, args: string[]): Promise<void> {
  const subcmd = args[0];
  if (subcmd === 'list' || !subcmd) {
    const wings = palace.listWings();
    if (wings.length === 0) {
      console.log('No wings yet. Create one: athenamem wings add <name> [--desc "description"]');
      return;
    }
    console.log('# Wings\n');
    for (const w of wings) {
      console.log(`  ${w.name} — ${w.description || '(no description)'} (${w.room_count} rooms, ${w.memory_count} memories)`);
    }
  } else if (subcmd === 'add') {
    const name = args[1];
    const descIdx = args.indexOf('--desc');
    const desc = descIdx >= 0 ? args[descIdx + 1] : '';
    if (!name) throw new Error('Usage: athenamem wings add <name> [--desc "description"]');
    palace.createWing(name, desc);
    console.log(`✅ Created wing: ${name}`);
  } else {
    throw new Error('Usage: athenamem wings [list|add]');
  }
}

async function cmdRooms(palace: Palace, args: string[]): Promise<void> {
  const wingName = args[0];
  if (!wingName) throw new Error('Usage: athenamem rooms <wing-name>');
  const rooms = palace.listRooms(wingName);
  if (rooms.length === 0) {
    console.log(`No rooms in wing "${wingName}".`);
    return;
  }
  console.log(`# Rooms in ${wingName}\n`);
  for (const r of rooms) {
    console.log(`  ${r.name} — ${r.description || '(no description)'} (${r.memory_count} memories)`);
  }
}

async function cmdDiary(palace: Palace, args: string[]): Promise<void> {
  // Usage: diary <agent-name> [write|read] [content]
  const agent = args[0];
  const action = args[1] ?? 'read';
  if (!agent) throw new Error('Usage: athenamem diary <agent-name> [write|read] [content]');

  if (action === 'write') {
    const content = args.slice(2).join(' ');
    if (!content) throw new Error('Usage: athenamem diary <agent> write <content>');
    palace.getOrCreateRoom(agent, 'diary');
    palace.addDrawer(agent, 'diary', 'discoveries', `diary-${Date.now()}.md`, content);
    console.log(`✅ Diary entry written for ${agent}`);
  } else {
    const memories = palace['kg'].getMemoriesByPalace(agent, 'diary');
    if (memories.length === 0) {
      console.log(`No diary entries for ${agent}.`);
      return;
    }
    console.log(`# Diary: ${agent}\n`);
    for (const m of memories.slice(0, 10)) {
      console.log(`[${new Date(m.created_at).toISOString()}] ${m.content}`);
      console.log('');
    }
  }
}

async function cmdAudit(kg: KnowledgeGraph): Promise<void> {
  const contradictions = kg.stats().contradictions;
  if (contradictions === 0) {
    console.log('✅ No contradictions flagged.');
    return;
  }
  console.log(`⚠️  ${contradictions} contradiction(s) flagged. Run "athenamem recall" to review.`);
}

async function cmdCompact(kg: KnowledgeGraph, palace: Palace, workDir: string): Promise<void> {
  console.log('Running compaction...');
  // TODO: wire in CompactionEngine
  console.log('✅ Compaction scheduled (not yet wired to LLM).');
}

async function cmdStats(kg: KnowledgeGraph): Promise<void> {
  const s = kg.stats();
  console.log(JSON.stringify(s, null, 2));
}

async function cmdExport(kg: KnowledgeGraph, args: string[]): Promise<void> {
  const outPath = args[0] ?? 'athenamem-export.json';
  const data = kg.export();
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`✅ Exported ${kg.stats().entity_count} entities to ${outPath}`);
}

async function cmdImport(kg: KnowledgeGraph, args: string[]): Promise<void> {
  const inPath = args[0];
  if (!inPath) throw new Error('Usage: athenamem import <file.json>');
  const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
  kg.import(data);
  console.log(`✅ Imported from ${inPath}`);
}

async function cmdTunnel(palace: Palace, args: string[]): Promise<void> {
  const from = args[0];
  const to = args[1];
  const roomName = args[2];
  if (!from || !to || !roomName) throw new Error('Usage: athenamem tunnel <from-wing> <to-wing> <room-name>');
  const tunnel = palace.createTunnel(from, to, roomName);
  console.log(`✅ Created tunnel: ${from} --[${roomName}]--> ${to}`);
}

// ─── Help ──────────────────────────────────────────────────────────────────────

function printHelp(topic?: string): void {
  const help: Record<string, string> = {
    '': `AthenaMem v${VERSION} — The memory that learns.

Usage: athenamem <command> [options]

Commands:
  init [name]           Initialize workspace
  status                Show palace overview + KG stats
  wake                  Load context (for agent bootstrap)
  checkpoint            Save WAL checkpoint
  sleep [summary]       End session
  remember <w> <r>       Store a memory (see help remember)
  recall <query>        Deep search across all systems
  search <query>        Quick search (qmd + KG)
  wings [list|add]      Manage wings
  rooms <wing>          List rooms in a wing
  diary <agent> [write] Read/write agent diary
  audit                 Check for contradictions
  stats                 KG statistics
  export [file]          Export KG as JSON
  import <file>         Import KG from JSON
  tunnel <f> <t> <room> Create cross-wing tunnel

Run "athenamem help <command>" for detailed help.`,
    remember: `Usage: athenamem remember <wing> <room> [options]

Options:
  --content "text"      Required. The memory content to store.
  --hall <type>         Hall type: facts|events|discoveries|preferences|advice (default: facts)

Example:
  athenamem remember chris memory-stack --content "Using SQLite for the KG" --hall discoveries`,
    recall: `Usage: athenamem recall <query> [options]

Fires queries across all configured memory systems (qmd, ClawVault,
Hindsight, Mnemo Cortex, AthenaMem KG) and fuses results using
Reciprocal Rank Fusion.

Example:
  athenamem recall "why did we switch databases"`,
    wings: `Usage: athenamem wings [list|add] [options]

list (default):  List all wings
add <name>:     Create a new wing

Options for add:
  --desc "text"  Wing description

Example:
  athenamem wings add chris --desc "Chris's personal memory wing"`,
  };

  console.log(help[topic ?? ''] ?? help['']);
}
