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
export {};
//# sourceMappingURL=index.d.ts.map