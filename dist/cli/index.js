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
 *   status            Show structure overview + system health
 *   wake              Load L0 + L1 context (for agent bootstrap)
 *   checkpoint        Save current state (WAL enforcement)
 *   sleep <summary>   End session, finalize
 *   remember          Store a new memory
 *   recall <query>    Search across all memory systems
 *   search <query>    Quick search (qmd + KG only)
 *   modules [list]    List or manage modules
 *   sections <module> List sections in a module
 *   diary <agent>     Write/read agent diary
 *   audit             Check for contradictions
 *   compact           Run DAG compaction
 *   stats             Show KG statistics
 *   export            Export KG as JSON
 *   import <file>     Import KG from JSON
 *   bridge <from> <to> <section>  Create cross-module bridge
 */
import { KnowledgeGraph } from '../core/kg.js';
import { Structure } from '../core/structure.js';
import { WALManager } from '../core/wal.js';
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
async function runCommand(cmd, args) {
    const home = process.env.HOME ?? '/home/chris';
    const workDir = path.join(home, '.openclaw', 'workspace', 'athenamem');
    const dataDir = path.join(workDir, 'data');
    const structureDir = path.join(workDir, 'structure');
    // Ensure directories exist
    for (const dir of [workDir, dataDir, structureDir]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
    const kg = new KnowledgeGraph(path.join(dataDir, 'athenamem.db'));
    const structure = new Structure(kg, structureDir);
    const wal = new WALManager(path.join(dataDir, 'wal'));
    switch (cmd) {
        case 'help':
            return printHelp(args[0]);
        case 'init':
            return cmdInit(workDir, args);
        case 'status':
            return cmdStatus(kg, structure);
        case 'wake':
            return cmdWake(kg, structure, wal, workDir);
        case 'checkpoint':
            return cmdCheckpoint(kg, structure, wal, workDir, args);
        case 'sleep':
            return cmdSleep(kg, structure, wal, workDir, args);
        case 'remember':
            return cmdRemember(kg, structure, args);
        case 'recall':
            return cmdRecall(kg, structure, args);
        case 'search':
            return cmdSearch(kg, structure, args);
        case 'rebuild-fts':
            return cmdRebuildFTS(kg);
        case 'modules':
            return cmdModules(structure, args);
        case 'sections':
            return cmdSections(structure, args);
        case 'diary':
            return cmdDiary(kg, structure, args);
        case 'audit':
            return cmdAudit(kg);
        case 'compact':
            return cmdCompact(kg, structure, workDir);
        case 'stats':
            return cmdStats(kg);
        case 'export':
            return cmdExport(kg, args);
        case 'import':
            return cmdImport(kg, args);
        case 'bridge':
            return cmdBridge(structure, args);
        case '--version':
        case 'version':
            return console.log(`AthenaMem v${VERSION}`);
        default:
            throw new Error(`Unknown command: ${cmd}. Run "athenamem help" for usage.`);
    }
}
// ─── Commands ─────────────────────────────────────────────────────────────────
function cmdInit(workDir, args) {
    const name = args[0] ?? 'athenamem';
    console.log(`Initializing ${name} at ${workDir}...`);
    console.log('Done. Run "athenamem status" to verify.');
}
async function cmdStatus(kg, structure) {
    const stats = kg.stats();
    const modules = structure.listModules();
    const walStats = new WALManager(path.join(process.env.HOME ?? '', '.openclaw', 'workspace', 'athenamem', 'data', 'wal')).stats();
    console.log(`
# AthenaMem Structure Status
=========================

## Knowledge Graph
  Entities:   ${stats.entity_count} (${stats.active_entities} active)
  Relations:   ${stats.relation_count}
  Memories:    ${stats.memory_count}
  Entries:     ${stats.entry_count}
  Contradictions flagged: ${stats.contradictions}

## Structure Modules
  ${modules.length === 0 ? 'No modules created yet.' : ''}
${modules.map(m => `  ${m.name} (${m.section_count} sections, ${m.memory_count} memories)`).join('\n')}

## WAL Status
  Total entries:  ${walStats.total_entries}
  Committed:     ${walStats.committed}
  Uncommitted:   ${walStats.uncommitted}
  Recovery:       ${walStats.recovery_available ? '✅ Available' : '❌ None'}
`);
}
async function cmdWake(kg, structure, wal, workDir) {
    const sessionStatePath = path.join(workDir, 'SESSION-STATE.md');
    const recovered = wal.recover();
    if (recovered) {
        console.log('⚠️  Recovered uncommitted state from previous session:');
        console.log(JSON.stringify(recovered.data, null, 2));
    }
    const latest = await wal.writeSessionState(sessionStatePath);
    if (latest) {
        console.log(`✅ Wrote session state to ${sessionStatePath}`);
    }
    else {
        console.log('No previous state found — fresh session.');
    }
}
async function cmdCheckpoint(kg, structure, wal, workDir, args) {
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
async function cmdSleep(kg, structure, wal, workDir, args) {
    const summary = args.join(' ') || 'Session ended.';
    const sessionStatePath = path.join(workDir, 'SESSION-STATE.md');
    let sessionState = '';
    if (fs.existsSync(sessionStatePath)) {
        sessionState = fs.readFileSync(sessionStatePath, 'utf-8');
    }
    wal.checkpoint({ session_state: sessionState, learnings: [summary] });
    console.log(`✅ Session ended. Summary: ${summary}`);
}
async function cmdRemember(kg, structure, args) {
    // Usage: remember <module> <section> [--content "text"] [--category facts|events|discoveries|preferences|advice]
    const module = args[0];
    const section = args[1];
    if (!module || !section)
        throw new Error('Usage: athenamem remember <module> <section> [--content "text"]');
    const contentIdx = args.indexOf('--content');
    const categoryIdx = args.indexOf('--category');
    const content = contentIdx >= 0 ? args[contentIdx + 1] : '';
    const category = (categoryIdx >= 0 ? args[categoryIdx + 1] : 'facts');
    if (!content)
        throw new Error('--content is required');
    const filePath = `${category}/${module}-${section}-${Date.now()}.md`;
    const { entry, memory } = structure.addEntry(module, section, category, filePath, content);
    console.log(`✅ Stored memory ${memory.id.substring(0, 8)}... in ${module}/${section}/${category}`);
    console.log(`   Entry: ${entry.entry_id.substring(0, 8)}...`);
}
async function cmdRecall(kg, structure, args) {
    const query = args.join(' ');
    if (!query)
        throw new Error('Usage: athenamem recall <query>');
    const orchestrator = new SearchOrchestrator(kg, structure);
    const response = await orchestrator.deepSearch(query, 30);
    console.log(formatSearchResults(response));
}
async function cmdSearch(kg, structure, args) {
    const query = args.join(' ');
    if (!query)
        throw new Error('Usage: athenamem search <query>');
    const orchestrator = new SearchOrchestrator(kg, structure);
    const results = await orchestrator.quickSearch(query, 15);
    console.log(`# Quick Search: "${query}"\n`);
    for (const r of results) {
        console.log(`[${r.source_name}] ${r.content.substring(0, 150)}`);
        console.log('');
    }
}
async function cmdModules(structure, args) {
    const subcmd = args[0];
    if (subcmd === 'list' || !subcmd) {
        const modules = structure.listModules();
        if (modules.length === 0) {
            console.log('No modules yet. Create one: athenamem modules add <name> [--desc "description"]');
            return;
        }
        console.log('# Modules\n');
        for (const m of modules) {
            console.log(`  ${m.name} — ${m.description || '(no description)'} (${m.section_count} sections, ${m.memory_count} memories)`);
        }
    }
    else if (subcmd === 'add') {
        const name = args[1];
        const descIdx = args.indexOf('--desc');
        const desc = descIdx >= 0 ? args[descIdx + 1] : '';
        if (!name)
            throw new Error('Usage: athenamem modules add <name> [--desc "description"]');
        structure.createModule(name, desc);
        console.log(`✅ Created module: ${name}`);
    }
    else {
        throw new Error('Usage: athenamem modules [list|add]');
    }
}
async function cmdSections(structure, args) {
    const moduleName = args[0];
    if (!moduleName)
        throw new Error('Usage: athenamem sections <module-name>');
    const sections = structure.listSections(moduleName);
    if (sections.length === 0) {
        console.log(`No sections in module "${moduleName}".`);
        return;
    }
    console.log(`# Sections in ${moduleName}\n`);
    for (const s of sections) {
        console.log(`  ${s.name} — ${s.description || '(no description)'} (${s.memory_count} memories)`);
    }
}
async function cmdDiary(kg, structure, args) {
    // Usage: diary <agent-name> [write|read] [content]
    const agent = args[0];
    const action = args[1] ?? 'read';
    if (!agent)
        throw new Error('Usage: athenamem diary <agent-name> [write|read] [content]');
    if (action === 'write') {
        const content = args.slice(2).join(' ');
        if (!content)
            throw new Error('Usage: athenamem diary <agent> write <content>');
        structure.getOrCreateSection(agent, 'diary');
        structure.addEntry(agent, 'diary', 'discoveries', `diary-${Date.now()}.md`, content);
        console.log(`✅ Diary entry written for ${agent}`);
    }
    else {
        const memories = kg.getMemoriesByStructure(agent, 'diary');
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
async function cmdAudit(kg) {
    const contradictions = kg.stats().contradictions;
    if (contradictions === 0) {
        console.log('✅ No contradictions flagged.');
        return;
    }
    console.log(`⚠️  ${contradictions} contradiction(s) flagged. Run "athenamem recall" to review.`);
}
async function cmdCompact(kg, structure, workDir) {
    console.log('Running compaction...');
    // TODO: wire in CompactionEngine
    console.log('✅ Compaction scheduled (not yet wired to LLM).');
}
async function cmdStats(kg) {
    const s = kg.stats();
    console.log(JSON.stringify(s, null, 2));
}
async function cmdExport(kg, args) {
    const outPath = args[0] ?? 'athenamem-export.json';
    const data = kg.export();
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`✅ Exported ${kg.stats().entity_count} entities to ${outPath}`);
}
async function cmdImport(kg, args) {
    const inPath = args[0];
    if (!inPath)
        throw new Error('Usage: athenamem import <file.json>');
    const data = JSON.parse(fs.readFileSync(inPath, 'utf-8'));
    kg.import(data);
    console.log(`✅ Imported from ${inPath}`);
}
async function cmdBridge(structure, args) {
    const from = args[0];
    const to = args[1];
    const sectionName = args[2];
    if (!from || !to || !sectionName)
        throw new Error('Usage: athenamem bridge <from-module> <to-module> <section-name>');
    const bridge = structure.createBridge(from, to, sectionName);
    console.log(`✅ Created bridge: ${from} --[${sectionName}]--> ${to}`);
}
async function cmdRebuildFTS(kg) {
    console.log('Rebuilding FTS index...');
    kg.rebuildFTSIndex();
    console.log('✅ FTS index rebuilt');
}
// ─── Help ──────────────────────────────────────────────────────────────────────
function printHelp(topic) {
    const help = {
        '': `AthenaMem v${VERSION} — The memory that learns.

Usage: athenamem <command> [options]

Commands:
  init [name]           Initialize workspace
  status                Show structure overview + KG stats
  wake                  Load context (for agent bootstrap)
  checkpoint            Save WAL checkpoint
  sleep [summary]       End session
  remember <m> <s>       Store a memory (see help remember)
  recall <query>        Deep search across all systems
  search <query>        Quick search (qmd + KG)
  rebuild-fts           Rebuild FTS search index
  modules [list|add]    Manage modules
  sections <module>     List sections in a module
  diary <agent> [write] Read/write agent diary
  audit                 Check for contradictions
  stats                 KG statistics
  export [file]          Export KG as JSON
  import <file>         Import KG from JSON
  bridge <f> <t> <sec>  Create cross-module bridge

Run "athenamem help <command>" for detailed help.`,
        remember: `Usage: athenamem remember <module> <section> [options]

Options:
  --content "text"      Required. The memory content to store.
  --category <type>      Category type: facts|events|discoveries|preferences|advice (default: facts)

Example:
  athenamem remember chris memory-stack --content "Using SQLite for the KG" --category discoveries`,
        recall: `Usage: athenamem recall <query> [options]

Fires queries across all configured memory systems (qmd, ClawVault,
Hindsight, Mnemo Cortex, AthenaMem KG) and fuses results using
Reciprocal Rank Fusion.

Example:
  athenamem recall "why did we switch databases"`,
        modules: `Usage: athenamem modules [list|add] [options]

list (default):  List all modules
add <name>:     Create a new module

Options for add:
  --desc "text"  Module description

Example:
  athenamem modules add chris --desc "Chris's personal memory module"`,
    };
    console.log(help[topic ?? ''] ?? help['']);
}
//# sourceMappingURL=index.js.map