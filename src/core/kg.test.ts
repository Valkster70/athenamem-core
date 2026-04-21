import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { KnowledgeGraph } from './kg.js';

const tempDirs: string[] = [];

function makeDbPath(name = 'kg.sqlite'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athenamem-kg-'));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('KnowledgeGraph entity types', () => {
  it('supports date and location entities in a fresh database', () => {
    const kg = new KnowledgeGraph(makeDbPath());

    const date = kg.addEntity('2026-04-20', 'date', { kind: 'calendar_day' });
    const location = kg.addEntity('MTE', 'location', { city: 'Rockford' });

    expect(date.type).toBe('date');
    expect(location.type).toBe('location');
    expect(kg.getEntity('2026-04-20', 'date')?.type).toBe('date');
    expect(kg.getEntity('MTE', 'location')?.type).toBe('location');

    kg.close();
  });

  it('migrates an existing database so date and location entities can be added', () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN (
          'person','project','topic','decision','lesson','event','preference','agent'
        )),
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_to INTEGER,
        metadata JSON DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 1.0,
        last_accessed INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'archived')),
        area TEXT
      );

      CREATE TABLE relations (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL REFERENCES entities(id),
        predicate TEXT NOT NULL,
        object_id TEXT NOT NULL REFERENCES entities(id),
        valid_from INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        valid_to INTEGER,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        last_accessed INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        memory_type TEXT NOT NULL,
        section TEXT NOT NULL,
        module TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        contradiction_flag INTEGER NOT NULL DEFAULT 0,
        contradiction_with TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        valid_to INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        last_accessed INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE entries (
        entry_id TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        section TEXT NOT NULL,
        category TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE TABLE drawers (
        drawer_id TEXT PRIMARY KEY,
        wing TEXT NOT NULL,
        room TEXT NOT NULL,
        hall TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );
    `);

    db.prepare(`
      INSERT INTO entities (id, name, type, created_at, valid_from, metadata, confidence, access_count, status)
      VALUES ('old-person', 'Chris', 'person', 1, 1, '{}', 0.9, 3, 'active')
    `).run();
    db.close();

    const kg = new KnowledgeGraph(dbPath);
    const migrated = kg.addEntity('Chicago, IL', 'location', { state: 'IL' });

    expect(migrated.type).toBe('location');
    expect(kg.getEntity('Chris', 'person')?.name).toBe('Chris');
    expect(kg.getEntity('Chicago, IL', 'location')?.type).toBe('location');

    kg.close();
  });
});
