import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { WALManager } from './wal.js';

const tempDirs: string[] = [];

function makeWal(): { wal: WALManager; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athenamem-wal-'));
  tempDirs.push(dir);
  return { wal: new WALManager(dir, 'test-agent', 'test-session'), dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WALManager', () => {
  it('commits a single begin without leaving an uncommitted duplicate behind', () => {
    const { wal } = makeWal();

    wal.begin({ session_state: 'hello' });
    wal.commit();

    expect(wal.getUncommitted()).toEqual([]);
    expect(wal.stats().committed).toBe(1);
    expect(wal.stats().uncommitted).toBe(0);
  });

  it('supports nested begin/commit cycles without orphaning the outer entry', () => {
    const { wal } = makeWal();

    wal.begin({ session_state: 'outer' });
    wal.begin({ session_state: 'inner' });
    wal.commit();

    expect(wal.getUncommitted().map(e => e.data.session_state)).toEqual(['outer']);

    wal.commit();

    expect(wal.getUncommitted()).toEqual([]);
    expect(wal.stats().committed).toBe(2);
    expect(wal.stats().uncommitted).toBe(0);
  });

  it('recovers the latest uncommitted WAL entry when the recovery file was overwritten by a nested commit', () => {
    const { wal } = makeWal();

    wal.begin({ session_state: 'outer' });
    wal.begin({ session_state: 'inner' });
    wal.commit();

    const recovered = wal.recover();
    expect(recovered?.committed).toBe(false);
    expect(recovered?.data.session_state).toBe('outer');
  });
});
