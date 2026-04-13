/**
 * AthenaMem WAL (Write-Ahead Log) Enforcement
 *
 * Inspired by Elite Longterm Memory's core insight:
 * "Write state BEFORE responding, not after."
 *
 * This module ensures that before an agent generates any response,
 * its current context is durably saved to disk.
 *
 * If the agent crashes between the WAL write and the response,
 * context is NOT lost. The WAL entry can be recovered.
 */
export interface WALEntry {
    id: string;
    timestamp: number;
    agent_id: string;
    session_id: string;
    event_type: 'bootstrap' | 'turn' | 'checkpoint' | 'recover' | 'compact';
    data: {
        session_state?: string;
        recent_context?: string;
        decisions?: string[];
        tasks?: string[];
        open_threads?: string[];
        errors?: string[];
        learnings?: string[];
    };
    committed: boolean;
    flushed_at?: number;
}
export interface WALStats {
    total_entries: number;
    committed: number;
    uncommitted: number;
    oldest_entry: number | null;
    newest_entry: number | null;
    recovery_available: boolean;
}
export declare class WALManager {
    private walDir;
    private activeEntry;
    private agentId;
    private sessionId;
    constructor(walDir: string, agentId?: string, sessionId?: string);
    private ensureDir;
    private getWalPath;
    private getRecoveryPath;
    /**
     * BEGIN — Call before processing a turn.
     * Writes current state to WAL, durable.
     *
     * This is the WAL enforcement: state is written BEFORE the agent responds.
     * If crash occurs here, state is saved and recoverable.
     */
    begin(entry: Partial<WALEntry['data']>): WALEntry;
    /**
     * COMMIT — Call after a successful response.
     * Marks the active WAL entry as committed.
     */
    commit(): void;
    /**
     * CHECKPOINT — Explicit state save (not tied to a turn).
     * Used during heavy work or before context compaction.
     */
    checkpoint(data: Partial<WALEntry['data']>): WALEntry;
    /**
     * RECOVER — Check for uncommitted entries from a crash and recover state.
     */
    recover(): WALEntry | null;
    /**
     * Get recent uncommitted entries (for recovery checking).
     */
    getUncommitted(): WALEntry[];
    /**
     * Write SESSION-STATE.md from the latest committed WAL entry.
     * Called on agent bootstrap to restore state.
     */
    writeSessionState(outputPath: string): Promise<WALEntry | null>;
    /**
     * Get the latest committed WAL entry.
     */
    getLatest(): WALEntry | null;
    stats(): WALStats;
    /**
     * Clean up old WAL entries beyond a certain age.
     * Keeps the last N entries or entries within the last N days.
     */
    prune(maxEntries?: number, maxAgeDays?: number): number;
    /**
     * Set session ID (e.g., on session rotation).
     */
    setSession(sessionId: string): void;
    /**
     * Set agent ID.
     */
    setAgent(agentId: string): void;
}
//# sourceMappingURL=wal.d.ts.map