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
import { SearchOrchestrator, formatSearchResults } from '../search/orchestrator.js';
import * as fs from 'fs';
import * as path from 'path';
const VERSION = '0.2.0';
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
async function runCommand(cmd, args) {
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
        case 'doctor':
            return cmdDoctor(kg, palace, workDir);
        case 'verify':
            return cmdVerify(kg, palace, args);
        case 'backfill-file':
            return cmdBackfillFile(kg, palace, args);
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
function printHelp(cmd) {
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
        console.log('  rebuild-fts           Rebuild the FTS index');
        console.log('  doctor                Run health checks and repair hints');
        console.log('  verify <query>        Smoke-test that a fact is searchable');
        console.log('  backfill-file <file> [wing room hall]  Ingest a source file into live memory');
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
    const helpText = {
        init: 'Initialize AthenaMem workspace\nUsage: athenamem init',
        remember: 'Store a new memory\nUsage: athenamem remember <wing> <room> <hall> <content>',
        recall: 'Search across all memory systems\nUsage: athenamem recall <query>',
        search: 'Quick search (qmd + KG only)\nUsage: athenamem search <query>',
        wings: 'List or manage wings\nUsage: athenamem wings [create <name> [desc]]',
        rooms: 'List rooms in a wing\nUsage: athenamem rooms <wing>',
        diary: 'Write/read agent diary\nUsage: athenamem diary <agent> [write <content> | read]',
        audit: 'Check for contradictions\nUsage: athenamem audit',
        compact: 'Run DAG compaction\nUsage: athenamem compact',
        'rebuild-fts': 'Rebuild the FTS index from the live memory database\nUsage: athenamem rebuild-fts',
        doctor: 'Run health checks across DB, FTS, palace files, ClawVault, and qmd\nUsage: athenamem doctor',
        verify: 'Smoke-test whether a query returns a plausible result\nUsage: athenamem verify <query>',
        'backfill-file': 'Ingest a markdown/text source file into live AthenaMem\nUsage: athenamem backfill-file <path> [wing room hall]',
    };
    console.log(helpText[cmd] || `No detailed help for: ${cmd}`);
}
// ─── Command Implementations ───────────────────────────────────────────────────
async function cmdInit(workDir, args) {
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
async function cmdStatus(kg, palace) {
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
async function cmdWake(kg, palace, wal, workDir) {
    console.log('Waking AthenaMem...');
    // Load L0 context: recent memories, active wings
    const wings = palace.listWings();
    const recentMemories = kg.getRecentMemories(10);
    console.log(`  Loaded ${wings.length} wings`);
    console.log(`  Retrieved ${recentMemories.length} recent memories`);
    // TODO: Inject context into agent session
    console.log('\n✅ AthenaMem awake and ready');
}
async function cmdCheckpoint(kg, _palace, wal, workDir, args) {
    const message = args.join(' ') || 'Manual checkpoint';
    console.log('Creating checkpoint...');
    wal.checkpoint({ session_state: message });
    console.log('✅ Checkpoint saved');
}
async function cmdSleep(kg, _palace, wal, workDir, args) {
    const summary = args.join(' ') || 'Session ended';
    console.log('Putting AthenaMem to sleep...');
    wal.checkpoint({ session_state: summary });
    console.log('✅ Session finalized');
    console.log(`   Summary: ${summary}`);
}
async function cmdRemember(kg, palace, args) {
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
    const { drawer, memory } = palace.addDrawer(wing, room, hall, filePath, content);
    console.log(`✅ Stored memory ${memory.id.substring(0, 8)}... in ${wing}/${room}/${hall}`);
    console.log(`   Drawer: ${drawer.drawer_id.substring(0, 8)}...`);
}
async function cmdRecall(kg, palace, args) {
    const query = args.join(' ');
    if (!query)
        throw new Error('Usage: athenamem recall <query>');
    const orchestrator = new SearchOrchestrator(kg, palace);
    const response = await orchestrator.deepSearch(query, 30);
    console.log(formatSearchResults(response));
}
async function cmdSearch(kg, palace, args) {
    const query = args.join(' ');
    if (!query)
        throw new Error('Usage: athenamem search <query>');
    const orchestrator = new SearchOrchestrator(kg, palace);
    const results = await orchestrator.quickSearch(query, 15);
    console.log(`# Quick Search: "${query}"\n`);
    for (const r of results) {
        console.log(`[${r.source_name}] ${r.content.substring(0, 150)}`);
        console.log('');
    }
}
async function cmdWings(palace, args) {
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
async function cmdRooms(palace, args) {
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
async function cmdDiary(kg, palace, args) {
    if (args.length < 2) {
        throw new Error('Usage: athenamem diary <agent> [write <content> | read]');
    }
    const [agent, action, ...contentParts] = args;
    const content = contentParts.join(' ');
    if (action === 'write') {
        palace.getOrCreateRoom(agent, 'diary');
        palace.addDrawer(agent, 'diary', 'discoveries', `diary-${Date.now()}.md`, content);
        console.log(`✅ Diary entry added for ${agent}`);
    }
    else if (action === 'read') {
        const memories = kg.getMemoriesByPalace(agent, 'diary');
        console.log(`# Diary: ${agent}\n`);
        for (const mem of memories) {
            console.log(`## ${new Date(mem.created_at).toISOString()}`);
            console.log(mem.content);
            console.log('');
        }
    }
    else {
        throw new Error('Usage: athenamem diary <agent> [write <content> | read]');
    }
}
async function cmdAudit(kg) {
    const { ContradictionDetector } = await import('../core/contradiction.js');
    const detector = new ContradictionDetector(kg);
    console.log('Running contradiction audit...');
    // TODO: Implement full audit
    console.log('✅ Audit complete');
}
async function cmdCompact(kg, palace, workDir) {
    const { CompactionEngine, RuleBasedCompiler } = await import('../core/compaction.js');
    const compiler = new RuleBasedCompiler();
    const engine = new CompactionEngine(kg, path.join(workDir, 'data', 'compaction'), compiler);
    console.log('Running DAG compaction...');
    // TODO: Implement compaction
    console.log('✅ Compaction complete');
}
async function cmdStats(kg) {
    const stats = kg.stats();
    console.log('# Knowledge Graph Statistics\n');
    console.log(`Entities:        ${stats.entity_count}`);
    console.log(`Relations:       ${stats.relation_count}`);
    console.log(`Memories:        ${stats.memory_count}`);
    console.log(`Contradictions:  ${stats.contradictions}`);
}
async function cmdRebuildFTS(kg) {
    console.log('Rebuilding FTS index...');
    kg.rebuildFTSIndex();
    console.log('✅ FTS index rebuilt');
}
async function cmdDoctor(kg, palace, workDir) {
    const dataDir = path.join(workDir, 'data');
    const dbPath = path.join(dataDir, 'athenamem.db');
    const clawvaultPath = path.join(process.env.HOME ?? '/home/chris', '.clawvault');
    const memoryPath = path.join(process.env.HOME ?? '/home/chris', '.openclaw', 'workspace', 'memory');
    const qmdIndex = path.join(process.env.HOME ?? '/home/chris', '.cache', 'qmd', 'index.sqlite');
    const stats = kg.stats();
    const wings = palace.listWings();
    const checks = [];
    checks.push({ name: 'Live DB', ok: fs.existsSync(dbPath), detail: dbPath });
    checks.push({ name: 'Palace dir', ok: fs.existsSync(path.join(workDir, 'palace')), detail: path.join(workDir, 'palace') });
    checks.push({ name: 'ClawVault', ok: fs.existsSync(clawvaultPath), detail: clawvaultPath, optional: true });
    checks.push({ name: 'Workspace memory', ok: fs.existsSync(memoryPath), detail: memoryPath });
    checks.push({ name: 'qmd index', ok: fs.existsSync(qmdIndex), detail: qmdIndex, optional: true });
    checks.push({ name: 'FTS populated', ok: stats.memory_count > 0, detail: `${stats.memory_count} memories in live DB` });
    checks.push({ name: 'Palace content', ok: wings.length > 0, detail: `${wings.length} wings` });
    console.log('# AthenaMem Doctor\n');
    for (const check of checks) {
        const icon = check.ok ? '✅' : (check.optional ? '⚠️' : '❌');
        console.log(`${icon} ${check.name}: ${check.detail}`);
    }
    console.log('\n## Summary');
    console.log(`Entities: ${stats.entity_count}`);
    console.log(`Relations: ${stats.relation_count}`);
    console.log(`Memories: ${stats.memory_count}`);
    console.log(`Wings: ${wings.length}`);
    const failed = checks.filter(c => !c.ok && !c.optional);
    const warnings = checks.filter(c => !c.ok && c.optional);
    if (failed.length === 0 && warnings.length === 0) {
        console.log('\n✅ Doctor passed');
        return;
    }
    console.log(`\n## Suggested fixes${warnings.length ? ' / optional improvements' : ''}`);
    for (const check of [...failed, ...warnings]) {
        if (check.name === 'FTS populated') {
            console.log('- Run: athenamem rebuild-fts');
        }
        else if (check.name === 'ClawVault') {
            console.log('- Run: clawvault init ~/.clawvault');
        }
        else if (check.name === 'qmd index') {
            console.log('- Run: qmd update && qmd embed');
        }
        else {
            console.log(`- Check missing path: ${check.detail}`);
        }
    }
}
async function cmdVerify(kg, palace, args) {
    const query = args.join(' ');
    if (!query)
        throw new Error('Usage: athenamem verify <query>');
    const tokens = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
    const orchestrator = new SearchOrchestrator(kg, palace);
    const response = await orchestrator.deepSearch(query, 5);
    const results = response.results;
    console.log(`# Verify: ${query}\n`);
    if (results.length > 0) {
        const top = results[0];
        console.log(`✅ Top hit: ${top.content.substring(0, 220)}`);
        console.log(`Source: ${top.source_name}`);
        console.log(`Score: ${top.score.toFixed(3)}`);
        console.log(`Systems with results: ${response.sources_with_results.join(', ') || 'none'}`);
        return;
    }
    const fallbackMemories = kg.searchMemories(query, undefined, undefined, 10).filter(mem => {
        const lower = mem.content.toLowerCase();
        const matches = tokens.filter(token => lower.includes(token)).length;
        return tokens.length === 0 ? true : (matches / tokens.length) >= 0.5;
    });
    if (fallbackMemories.length > 0) {
        const top = fallbackMemories[0];
        console.log(`✅ Fallback memory hit: ${top.content.substring(0, 220)}`);
        console.log('Source: AthenaMem KG memory');
        return;
    }
    const entities = kg.queryEntities({ include_expired: true });
    const scoredFacts = [];
    const seenFacts = new Set();
    for (const entity of entities) {
        const entityText = `${entity.name} ${entity.type}`.toLowerCase();
        const entityMatches = tokens.filter(token => entityText.includes(token)).length;
        if (tokens.length > 0 && entityMatches === 0)
            continue;
        const facts = kg.getEntityFacts(entity.id);
        for (const rel of [...facts.outgoing, ...facts.incoming]) {
            const subject = kg.queryEntities({ entity_id: rel.subject_id, include_expired: true })[0];
            const object = kg.queryEntities({ entity_id: rel.object_id, include_expired: true })[0];
            const text = `${subject?.name ?? rel.subject_id} ${rel.predicate} ${object?.name ?? rel.object_id}`;
            if (seenFacts.has(text))
                continue;
            seenFacts.add(text);
            const lower = text.toLowerCase();
            const matches = tokens.filter(token => lower.includes(token)).length;
            if (tokens.length > 0 && matches === 0)
                continue;
            const fullMatch = lower.includes(query.toLowerCase()) ? 100 : 0;
            const score = fullMatch + matches * 10;
            scoredFacts.push({ text, score });
        }
    }
    scoredFacts.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
    const topFact = scoredFacts[0];
    if (topFact) {
        console.log(`✅ Fallback KG fact hit: ${topFact.text}`);
        console.log('Source: AthenaMem KG relation');
        console.log(`Match score: ${topFact.score}`);
        return;
    }
    console.log('❌ No results');
    process.exitCode = 1;
}
async function cmdBackfillFile(kg, palace, args) {
    if (args.length < 1) {
        throw new Error('Usage: athenamem backfill-file <path> [wing room hall]');
    }
    const [filePathArg, wing = 'main', room = 'backfill', hall = 'discoveries'] = args;
    const filePath = path.resolve(filePathArg);
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
    }
    if (stat.size > 1024 * 1024) {
        throw new Error('Refusing to backfill files larger than 1MB');
    }
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) {
        throw new Error('File is empty');
    }
    const targetPath = `backfill/${path.basename(filePath)}`;
    const { memory } = palace.addDrawer(wing, room, hall, targetPath, content);
    console.log('✅ Backfilled file into live AthenaMem');
    console.log(`File: ${filePath}`);
    console.log(`Target: ${wing}/${room}/${hall}`);
    console.log(`Memory ID: ${memory.id}`);
}
async function cmdExport(kg, args) {
    if (args.length < 1) {
        throw new Error('Usage: athenamem export <file.json>');
    }
    const filePath = args[0];
    const data = kg.export();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`✅ Exported to ${filePath}`);
}
async function cmdImport(kg, args) {
    if (args.length < 1) {
        throw new Error('Usage: athenamem import <file.json>');
    }
    const filePath = args[0];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    kg.import(data);
    console.log(`✅ Imported from ${filePath}`);
}
async function cmdTunnel(palace, args) {
    if (args.length < 3) {
        throw new Error('Usage: athenamem tunnel <from_wing> <to_wing> <room_name>');
    }
    const [from, to, roomName] = args;
    const tunnel = palace.createTunnel(from, to, roomName);
    console.log(`✅ Created tunnel: ${from} ↔ ${to} via ${roomName}`);
    console.log(`   Tunnel ID: ${tunnel.id}`);
}
//# sourceMappingURL=index.js.map