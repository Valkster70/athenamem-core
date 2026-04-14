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
export {};
//# sourceMappingURL=index.d.ts.map