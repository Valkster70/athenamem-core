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

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  committed: boolean;  // false = in-progress, true = response sent
  flushed_at?: number; // when this entry was persisted to SESSION-STATE.md
}

export interface WALStats {
  total_entries: number;
  committed: number;
  uncommitted: number;
  oldest_entry: number | null;
  newest_entry: number | null;
  recovery_available: boolean;
}

export interface WALFlushResult {
  flushed: number;
  remaining_uncommitted: number;
  recovery_available: boolean;
}

// ─── WAL Manager ───────────────────────────────────────────────────────────────

export class WALManager {
  private walDir: string;
  private activeEntry: WALEntry | null = null;
  private activeStack: WALEntry[] = [];
  private agentId: string;
  private sessionId: string;

  constructor(walDir: string, agentId: string = 'default', sessionId: string = 'default') {
    this.walDir = walDir;
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.walDir)) {
      fs.mkdirSync(this.walDir, { recursive: true });
    }
  }

  private getWalPath(): string {
    return path.join(this.walDir, `wal-${this.sessionId}.jsonl`);
  }

  private getRecoveryPath(): string {
    return path.join(this.walDir, `recovery-${this.sessionId}.json`);
  }

  // ─── Core Operations ────────────────────────────────────────────────────────

  /**
   * BEGIN — Call before processing a turn.
   * Writes current state to WAL, durable.
   * 
   * This is the WAL enforcement: state is written BEFORE the agent responds.
   * If crash occurs here, state is saved and recoverable.
   */
  begin(entry: Partial<WALEntry['data']>): WALEntry {
    const now = Date.now();
    this.activeEntry = {
      id: uuidv4(),
      timestamp: now,
      agent_id: this.agentId,
      session_id: this.sessionId,
      event_type: 'turn',
      data: {
        session_state: entry.session_state ?? '',
        recent_context: entry.recent_context ?? '',
        decisions: entry.decisions ?? [],
        tasks: entry.tasks ?? [],
        open_threads: entry.open_threads ?? [],
        learnings: entry.learnings ?? [],
      },
      committed: false,
    };

    // Write to WAL file (append-only, durable)
    const line = JSON.stringify(this.activeEntry) + '\n';
    fs.appendFileSync(this.getWalPath(), line, 'utf-8');

    // Write recovery file (overwritten each time, for crash recovery)
    fs.writeFileSync(this.getRecoveryPath(), JSON.stringify(this.activeEntry, null, 2), 'utf-8');

    this.activeStack.push(this.activeEntry);

    return this.activeEntry;
  }

  /**
   * COMMIT — Call after a successful response.
   * Marks the active WAL entry as committed.
   */
  commit(): void {
    const current = this.activeStack.pop() ?? this.activeEntry;
    if (!current) return;

    current.committed = true;
    current.flushed_at = Date.now();

    const walPath = this.getWalPath();
    if (fs.existsSync(walPath)) {
      const lines = fs.readFileSync(walPath, 'utf-8').split('\n');
      let changed = false;

      const rewritten = lines.map((line) => {
        if (!line.trim()) return line;
        try {
          const entry = JSON.parse(line) as WALEntry;
          if (entry.id === current.id) {
            changed = true;
            return JSON.stringify(current);
          }
        } catch {
          // preserve malformed lines rather than deleting history
        }
        return line;
      });

      if (changed) {
        fs.writeFileSync(walPath, rewritten.join('\n'), 'utf-8');
      } else {
        fs.appendFileSync(walPath, JSON.stringify(current) + '\n', 'utf-8');
      }
    } else {
      fs.appendFileSync(walPath, JSON.stringify(current) + '\n', 'utf-8');
    }

    // Update the recovery file with committed state
    const nextActive = this.activeStack.length > 0 ? this.activeStack[this.activeStack.length - 1] : null;
    this.activeEntry = nextActive;
    fs.writeFileSync(this.getRecoveryPath(), JSON.stringify(nextActive ?? current, null, 2), 'utf-8');
  }

  /**
   * CHECKPOINT — Explicit state save (not tied to a turn).
   * Used during heavy work or before context compaction.
   */
  checkpoint(data: Partial<WALEntry['data']>): WALEntry {
    const entry: WALEntry = {
      id: uuidv4(),
      timestamp: Date.now(),
      agent_id: this.agentId,
      session_id: this.sessionId,
      event_type: 'checkpoint',
      data: {
        session_state: data.session_state ?? '',
        recent_context: data.recent_context ?? '',
        decisions: data.decisions ?? [],
        tasks: data.tasks ?? [],
        open_threads: data.open_threads ?? [],
        learnings: data.learnings ?? [],
      },
      committed: true,
      flushed_at: Date.now(),
    };

    fs.appendFileSync(this.getWalPath(), JSON.stringify(entry) + '\n', 'utf-8');
    fs.writeFileSync(this.getRecoveryPath(), JSON.stringify(entry, null, 2), 'utf-8');
    return entry;
  }

  /**
   * RECOVER — Check for uncommitted entries from a crash and recover state.
   */
  recover(): WALEntry | null {
    const recoveryPath = this.getRecoveryPath();
    if (fs.existsSync(recoveryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(recoveryPath, 'utf-8'));
        if (!data.committed) {
          console.warn(`[WAL] Recovered uncommitted entry from ${new Date(data.timestamp).toISOString()}`);
          return data as WALEntry;
        }
      } catch (e) {
        console.error('[WAL] Failed to read recovery file:', e);
      }
    }

    const uncommitted = this.getUncommitted();
    if (uncommitted.length === 0) return null;

    const latest = uncommitted.reduce((acc, entry) => entry.timestamp > acc.timestamp ? entry : acc);
    console.warn(`[WAL] Recovered uncommitted WAL entry from ${new Date(latest.timestamp).toISOString()}`);
    return latest;
  }

  /**
   * Get recent uncommitted entries (for recovery checking).
   */
  getUncommitted(): WALEntry[] {
    const walPath = this.getWalPath();
    if (!fs.existsSync(walPath)) return [];

    const lines = fs.readFileSync(walPath, 'utf-8').trim().split('\n');
    const entries: WALEntry[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as WALEntry;
        if (!entry.committed) entries.push(entry);
      } catch { /* skip malformed lines */ }
    }

    return entries;
  }

  // ─── Bootstrap Integration ─────────────────────────────────────────────────

  /**
   * Write SESSION-STATE.md from the latest committed WAL entry.
   * Called on agent bootstrap to restore state.
   */
  async writeSessionState(outputPath: string): Promise<WALEntry | null> {
    const latest = this.getLatest();
    if (!latest) return null;

    const content = [
      '# SESSION-STATE.md',
      '',
      `> Auto-generated by AthenaMem WAL. Last updated: ${new Date(latest.timestamp).toISOString()}`,
      '',
      '## Session Info',
      `- Agent: ${this.agentId}`,
      `- Session: ${this.sessionId}`,
      `- Last event: ${latest.event_type}`,
      '',
      '## Current Context',
      latest.data.session_state ?? '',
      '',
      '## Recent Decisions',
      ...(latest.data.decisions ?? []).map(d => `- ${d}`),
      '',
      '## Active Tasks',
      ...(latest.data.tasks ?? []).map(t => `- ${t}`),
      '',
      '## Open Threads',
      ...(latest.data.open_threads ?? []).map(t => `- ${t}`),
      '',
      '## Learnings',
      ...(latest.data.learnings ?? []).map(l => `- ${l}`),
      '',
    ].join('\n');

    fs.writeFileSync(outputPath, content, 'utf-8');
    return latest;
  }

  /**
   * Get the latest committed WAL entry.
   */
  getLatest(): WALEntry | null {
    const walPath = this.getWalPath();
    if (!fs.existsSync(walPath)) return null;

    const lines = fs.readFileSync(walPath, 'utf-8').trim().split('\n');
    let latest: WALEntry | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as WALEntry;
        if (entry.committed && (!latest || entry.timestamp > latest.timestamp)) {
          latest = entry;
        }
      } catch { /* skip */ }
    }

    return latest;
  }

  // ─── Statistics ─────────────────────────────────────────────────────────────

  stats(): WALStats {
    const walPath = this.getWalPath();
    const recoveryPath = this.getRecoveryPath();

    if (!fs.existsSync(walPath)) {
      return {
        total_entries: 0,
        committed: 0,
        uncommitted: 0,
        oldest_entry: null,
        newest_entry: null,
        recovery_available: fs.existsSync(recoveryPath),
      };
    }

    const lines = fs.readFileSync(walPath, 'utf-8').trim().split('\n');
    let total = 0, committed = 0, uncommitted = 0;
    let oldest: number | null = null;
    let newest: number | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as WALEntry;
        total++;
        if (entry.committed) committed++;
        else uncommitted++;
        if (!oldest || entry.timestamp < oldest) oldest = entry.timestamp;
        if (!newest || entry.timestamp > newest) newest = entry.timestamp;
      } catch { /* skip */ }
    }

    return {
      total_entries: total,
      committed,
      uncommitted,
      oldest_entry: oldest,
      newest_entry: newest,
      recovery_available: fs.existsSync(recoveryPath),
    };
  }

  // ─── Maintenance ────────────────────────────────────────────────────────────

  /**
   * Clean up old WAL entries beyond a certain age.
   * Keeps the last N entries or entries within the last N days.
   */
  prune(maxEntries: number = 1000, maxAgeDays: number = 30): number {
    const walPath = this.getWalPath();
    if (!fs.existsSync(walPath)) return 0;

    const lines = fs.readFileSync(walPath, 'utf-8').trim().split('\n');
    const entries: WALEntry[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as WALEntry);
      } catch { /* skip */ }
    }

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const kept = entries.filter((e, i) => i >= entries.length - maxEntries || e.timestamp > cutoff);

    if (kept.length < entries.length) {
      const newContent = kept.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(walPath, newContent, 'utf-8');
      return entries.length - kept.length;
    }

    return 0;
  }

  /**
   * Mark all currently uncommitted WAL entries as committed.
   * Useful for an explicit operator-triggered flush/checkpoint.
   */
  flush(): WALFlushResult {
    const walPath = this.getWalPath();
    if (!fs.existsSync(walPath)) {
      return {
        flushed: 0,
        remaining_uncommitted: 0,
        recovery_available: fs.existsSync(this.getRecoveryPath()),
      };
    }

    const lines = fs.readFileSync(walPath, 'utf-8').split('\n');
    const now = Date.now();
    let flushed = 0;

    const rewritten = lines.map((line) => {
      if (!line.trim()) return line;
      try {
        const entry = JSON.parse(line) as WALEntry;
        if (!entry.committed) {
          entry.committed = true;
          entry.flushed_at = now;
          flushed++;
          return JSON.stringify(entry);
        }
      } catch {
        // preserve malformed lines rather than deleting history
      }
      return line;
    });

    if (flushed > 0) {
      fs.writeFileSync(walPath, rewritten.join('\n'), 'utf-8');
      const latest = this.getLatest();
      if (latest) {
        fs.writeFileSync(this.getRecoveryPath(), JSON.stringify(latest, null, 2), 'utf-8');
      }
      this.activeEntry = null;
      this.activeStack = [];
    }

    const stats = this.stats();
    return {
      flushed,
      remaining_uncommitted: stats.uncommitted,
      recovery_available: stats.recovery_available,
    };
  }

  /**
   * Set session ID (e.g., on session rotation).
   */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Set agent ID.
   */
  setAgent(agentId: string): void {
    this.agentId = agentId;
  }
}
