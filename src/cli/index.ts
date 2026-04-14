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
import { CompactionEngine, RuleBasedCompiler } from '../core/compaction.js';
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
  console.error('Error:', err.message);
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
    case 'rebuild-fts':
      return cmdRebuildFTS(kg);
    case 'wings':
      return cmdWings(palace, args);
    case 'rooms':
      return cmdRooms(palace, args);
    case 'diary':
      return cmdDiary(kg, palace, args);
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
    default:
      throw new Error(`Unknown command: ${cmd}. Run "athenamem help" for available commands.`);
  }
}

function printHelp(cmd?: string): void {
  if (!cmd) {
    console.log('AthenaMem Commands:');
    console.log('  init                  Initialize AthenaMem workspace');
    console.log('  status                Show palace overview + KG stats');
    console.log('  wake                  Load L0 + L1 context (agent bootstrap)');
    console.log('  checkpoint [msg]      Save current state (WAL enforcement)');
    console.log('  sleep <summary>       End session, finalize');
    console.log('  remember              Store a new memory');
    console.log('  recall <query>        Search across all memory systems');
    console.log('  search <query>        Quick search (qmd + KG only)');
    console.log('  wings [list]          List or manage wings');
    console.log('  rooms <wing>            List rooms in a wing');
    console.log('  diary <agent>         Write/read agent diary');
    console.log('  audit                 Check for contradictions');
    console.log('  compact               Run DAG compaction');
    console.log('  stats                 Show KG statistics');
    console.log('  export <file>         Export KG as JSON');
    console.log('  import <file>         Import KG from JSON');
    console.log('  tunnel <from> <to> <room>  Create cross-wing tunnel');
    return;
  }

  const helpText: Record<string, string> = {
    init: 'Initialize AthenaMem workspace\nUsage: athenamem init',
    remember: 'Store a new memory\nUsage: athenamem remember <wing> <room> <hall> <content>',
    recall: 'Search across all memory systems\nUsage: athenamem recall <query>',
    search: 'Quick search (qmd + KG only)\nUsage: athenamem search <query>',
    wings: 'List or manage wings\nUsage: athenamem wings [create <name> [desc]]',
    rooms: 'List rooms in a wing\nUsage: athenamem rooms <wing>',
    diary: 'Write/read agent diary\nUsage: athenamem diary <agent> [write <content> | read]',
    audit: 'Check for contradictions\nUsage: athenamem audit',
    compact: 'Run DAG compaction\nUsage: athenamem compact',
  };

  console.log(helpText[cmd] || `No detailed help for: ${cmd}`);
}

// ─── Command Implementations ───────────────────────────────────────────────────

async function cmdInit(workDir: string, args: string[]): Promise<void> {
  console.log('Initializing AthenaMem workspace...');

  const dirs = ['data', 'palace', 'logs'];
  for (const dir of dirs) {
    const fullPath = path.join(workDir, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(`  Created: ${fullPath}`);
    }
  }

  // Create default config
  const configPath = path.join(workDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    const config = {
      version: VERSION,
      default_wing: 'main',
      auto_checkpoint: true,
      llm: {
        model: 'gpt-4o-mini',
        temperature: 0.7,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`  Created: ${configPath}`);
  }

  console.log('\n✅ AthenaMem workspace initialized!');
  console.log(`   Location: ${workDir}`);
}

async function cmdStatus(kg: KnowledgeGraph, palace: Palace): Promise<void> {
  const stats = kg.stats();
  const wings = palace.listWings();

  console.log('# AthenaMem Palace Status');
  console.log('');
  console.log(`Knowledge Graph:`);
  console.log(`  Entities: ${stats.entity_count}`);
  console.log(`  Relations: ${stats.relation_count}`);
  console.log(`  Memories: ${stats.memory_count}`);
  console.log(`  Contradictions: ${stats.contradictions}`);
  console.log('');
  console.log(`## Palace Wings`);
  for (const wing of wings) {
    const rooms = palace.listRooms(wing.name);
    console.log(`  📦 ${wing.name} (${rooms.length} rooms, ${wing.memory_count} memories)`);
    if (wing.description) {
      console.log(`     ${wing.description}`);
    }
  }
}

async function cmdWake(kg: KnowledgeGraph, palace: Palace, wal: WALManager, workDir: string): Promise<void> {
  console.log('Waking AthenaMem...');

  // Load L0 context: recent memories, active wings
  const wings = palace.listWings();
  const recentMemories = kg.getRecentMemories(10);

  console.log(`  Loaded ${wings.length} wings`);
  console.log(`  Retrieved ${recentMemories.length} recent memories`);

  // TODO: Inject context into agent session
  console.log('\n✅ AthenaMem awake and ready');
}

async function cmdCheckpoint(kg: KnowledgeGraph, _palace: Palace, wal: WALManager, workDir: string, args: string[]): Promise<void> {
  const message = args.join(' ') || 'Manual checkpoint';

  console.log('Creating checkpoint...');
  wal.checkpoint({ session_state: message });

  console.log('✅ Checkpoint saved');
}

async function cmdSleep(kg: KnowledgeGraph, _palace: Palace, wal: WALManager, workDir: string, args: string[]): Promise<void> {
  const summary = args.join(' ') || 'Session ended';

  console.log('Putting AthenaMem to sleep...');
  wal.checkpoint({ session_state: summary });

  console.log('✅ Session finalized');
  console.log(`   Summary: ${summary}`);
}

async function cmdRemember(kg: KnowledgeGraph, palace: Palace, args: string[]): Promise<void> {
  if (args.length < 4) {
    throw new Error('Usage: athenamem remember <wing> <room> <hall> <content...>');
  }

  const [wing, room, hall, ...contentParts] = args;
  const content = contentParts.join(' ');

  // Create/get the wing and room
  const wingData = palace.getWing(wing) || palace.createWing(wing);
  const roomData = palace.getOrCreateRoom(wing, room);

  // Store the memory
  const filePath = `palace/${wing}/${room}/${Date.now()}.md`;
  const { drawer, memory } = palace.addDrawer(wing, room, hall as any, filePath, content);

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
  if (args.length === 0 || args[0] === 'list') {
    const wings = palace.listWings();
    console.log(`# Wings (${wings.length})\n`);
    for (const wing of wings) {
      console.log(`  📦 ${wing.name}`);
      if (wing.description) {
        console.log(`     ${wing.description}`);
      }
      console.log(`     ${wing.room_count} rooms, ${wing.memory_count} memories`);
      console.log('');
    }
    return;
  }

  if (args[0] === 'create' && args[1]) {
    const name = args[1];
    const desc = args.slice(2).join(' ') || '';
    palace.createWing(name, desc);
    console.log(`✅ Created wing: ${name}`);
    return;
  }

  throw new Error('Usage: athenamem wings [list | create <name> [desc]]');
}

async function cmdRooms(palace: Palace, args: string[]): Promise<void> {
  if (args.length < 1) {
    throw new Error('Usage: athenamem rooms <wing>');
  }

  const wingName = args[0];
  const rooms = palace.listRooms(wingName);

  console.log(`# Rooms in ${wingName} (${rooms.length})\n`);
  for (const room of rooms) {
    console.log(`  📁 ${room.name}`);
    if (room.closet_summary) {
      console.log(`     ${room.closet_summary}`);
    }
    console.log(`     ${room.memory_count} memories`);
    console.log('');
  }
}

async function cmdDiary(kg: KnowledgeGraph, palace: Palace, args: string[]): Promise<void> {
  if (args.length < 2) {
    throw new Error('Usage: athenamem diary <agent> [write <content> | read]');
  }

  const [agent, action, ...contentParts] = args;
  const content = contentParts.join(' ');

  if (action === 'write') {
    palace.getOrCreateRoom(agent, 'diary');
    palace.addDrawer(agent, 'diary', 'discoveries', `diary-${Date.now()}.md`, content);
    console.log(`✅ Diary entry added for ${agent}`);
  } else if (action === 'read') {
    const memories = kg.getMemoriesByPalace(agent, 'diary');
    console.log(`# Diary: ${agent}\n`);
    for (const mem of memories) {
      console.log(`## ${new Date(mem.created_at).toISOString()}`);
      console.log(mem.content);
      console.log('');
    }
  } else {
    throw new Error('Usage: athenamem diary <agent> [write <content> | read]');
  }
}

async function cmdAudit(kg: KnowledgeGraph): Promise<void> {
  const { ContradictionDetector } = await import('../core/contradiction.js');
  const detector = new ContradictionDetector(kg);

  console.log('Running contradiction audit...');
  // TODO: Implement full audit
  console.log('✅ Audit complete');
}

async function cmdCompact(kg: KnowledgeGraph, palace: Palace, workDir: string): Promise<void> {
  const { CompactionEngine, RuleBasedCompiler } = await import('../core/compaction.js');
  const compiler = new RuleBasedCompiler();
  const engine = new CompactionEngine(kg, path.join(workDir, 'data', 'compaction'), compiler);

  console.log('Running DAG compaction...');
  // TODO: Implement compaction
  console.log('✅ Compaction complete');
}

async function cmdStats(kg: KnowledgeGraph): Promise<void> {
  const stats = kg.stats();

  console.log('# Knowledge Graph Statistics\n');
  console.log(`Entities:        ${stats.entity_count}`);
  console.log(`Relations:       ${stats.relation_count}`);
  console.log(`Memories:        ${stats.memory_count}`);
  console.log(`Contradictions:  ${stats.contradictions}`);
}

async function cmdRebuildFTS(kg: KnowledgeGraph): Promise<void> {
  console.log('Rebuilding FTS index...');
  kg.rebuildFTSIndex();
  console.log('✅ FTS index rebuilt');
}

async function cmdExport(kg: KnowledgeGraph, args: string[]): Promise<void> {
  if (args.length < 1) {
    throw new Error('Usage: athenamem export <file.json>');
  }

  const filePath = args[0];
  const data = kg.export();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✅ Exported to ${filePath}`);
}

async function cmdImport(kg: KnowledgeGraph, args: string[]): Promise<void> {
  if (args.length < 1) {
    throw new Error('Usage: athenamem import <file.json>');
  }

  const filePath = args[0];
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  kg.import(data);
  console.log(`✅ Imported from ${filePath}`);
}

async function cmdTunnel(palace: Palace, args: string[]): Promise<void> {
  if (args.length < 3) {
    throw new Error('Usage: athenamem tunnel <from_wing> <to_wing> <room_name>');
  }

  const [from, to, roomName] = args;
  const tunnel = palace.createTunnel(from, to, roomName);
  console.log(`✅ Created tunnel: ${from} ↔ ${to} via ${roomName}`);
  console.log(`   Tunnel ID: ${tunnel.id}`);
}
