/**
 * AthenaMem Core Structure — Modules, Sections, Vaults, Entries
 * 
 * The structure is the top-level organizational metaphor for all memory.
 * Inspired by MemPalace's hierarchical approach, extended with categories and bridges.
 * 
 * Memory is organized as:
 * - MODULE: A person, agent, project, or concept (top-level container)
 * - SECTION: A topic or area within a module
 * - VAULT: A summary pointing to one or more entries
 * - ENTRY: A verbatim record (file or KG entry)
 * - CATEGORY: A category within a section (facts, events, discoveries, preferences, advice)
 * - BRIDGE: A cross-module connection (same section name bridges two modules)
 */

import { KnowledgeGraph, Memory, Entry, CategoryType } from './kg.js';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Module {
  id: string;
  name: string;           // e.g., "chris", "athena", "valk-systems"
  description: string;
  created_at: number;
  section_count: number;
  memory_count: number;
}

export interface Section {
  id: string;
  module_id: string;
  name: string;           // e.g., "memory-stack", "flutter-app", "meetings"
  description: string;
  vault_summary: string | null;  // LLM-generated summary
  memory_count: number;
  last_accessed: number | null;
}

export interface Vault {
  id: string;
  section_id: string;
  module_id: string;
  category: CategoryType;
  summary: string;
  source_entry_ids: string[];
  importance: number;
  created_at: number;
  last_accessed: number | null;
}

export interface Bridge {
  id: string;
  from_module: string;
  to_module: string;
  section_name: string;      // same section name bridges the modules
  description: string;
  memory_count: number;
}

// ─── Structure Class ─────────────────────────────────────────────────────────────

export class Structure {
  private kg: KnowledgeGraph;
  private structureDir: string;

  constructor(kg: KnowledgeGraph, structureDir: string) {
    this.kg = kg;
    this.structureDir = structureDir;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.structureDir)) {
      fs.mkdirSync(this.structureDir, { recursive: true });
    }
  }

  // ─── Modules ─────────────────────────────────────────────────────────────────

  /**
   * Create or get a module.
   * A module is the top-level container — typically one per person, agent, or project.
   */
  createModule(name: string, description: string = ''): Module {
    const entity = this.kg.addEntity(name, 'agent', { description, module_name: name });
    const now = Date.now();

    const moduleMeta = {
      id: uuidv4(),
      name,
      description,
      created_at: now,
      entity_id: entity.id,
    };

    const moduleFile = path.join(this.structureDir, `module-${name}.json`);
    if (!fs.existsSync(moduleFile)) {
      fs.writeFileSync(moduleFile, JSON.stringify(moduleMeta, null, 2), 'utf-8');
    }

    return {
      id: moduleMeta.id,
      name,
      description,
      created_at: now,
      section_count: 0,
      memory_count: 0,
    };
  }

  /**
   * List all modules.
   */
  listModules(): Module[] {
    const modules: Module[] = [];
    if (!fs.existsSync(this.structureDir)) return modules;

    for (const file of fs.readdirSync(this.structureDir)) {
      if (!file.startsWith('module-') || !file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.structureDir, file), 'utf-8'));
        const sections = this.listSections(data.name);
        const memories = this.kg.getMemoriesByStructure(data.name);
        modules.push({
          id: data.id,
          name: data.name,
          description: data.description ?? '',
          created_at: data.created_at,
          section_count: sections.length,
          memory_count: memories.length,
        });
      } catch { /* skip malformed files */ }
    }

    return modules.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get a module by name.
   */
  getModule(name: string): Module | null {
    const file = path.join(this.structureDir, `module-${name}.json`);
    if (!fs.existsSync(file)) return null;

    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const sections = this.listSections(name);
    const memories = this.kg.getMemoriesByStructure(name);

    return {
      id: data.id,
      name: data.name,
      description: data.description ?? '',
      created_at: data.created_at,
      section_count: sections.length,
      memory_count: memories.length,
    };
  }

  // ─── Sections ─────────────────────────────────────────────────────────────────

  /**
   * Create a section within a module.
   * A section is a topic or area of focus.
   */
  createSection(moduleName: string, sectionName: string, description: string = ''): Section {
    const module = this.getModule(moduleName);
    if (!module) throw new Error(`Module '${moduleName}' does not exist`);

    const sectionEntity = this.kg.addEntity(`${moduleName}::${sectionName}`, 'topic', { description, module: moduleName });

    const sectionMeta = {
      id: sectionEntity.id,
      module_id: module.id,
      name: sectionName,
      description,
      vault_summary: null,
      created_at: Date.now(),
    };

    const sectionFile = path.join(this.structureDir, `section-${moduleName}-${sectionName}.json`);
    fs.writeFileSync(sectionFile, JSON.stringify(sectionMeta, null, 2), 'utf-8');

    return {
      id: sectionMeta.id,
      module_id: module.id,
      name: sectionName,
      description,
      vault_summary: null,
      memory_count: 0,
      last_accessed: null,
    };
  }

  /**
   * List all sections within a module.
   */
  listSections(moduleName: string): Section[] {
    const sections: Section[] = [];
    if (!fs.existsSync(this.structureDir)) return sections;

    for (const file of fs.readdirSync(this.structureDir)) {
      if (!file.startsWith(`section-${moduleName}-`) || !file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.structureDir, file), 'utf-8'));
        const memories = this.kg.getMemoriesByStructure(moduleName, data.name);
        sections.push({
          id: data.id,
          module_id: data.module_id,
          name: data.name,
          description: data.description ?? '',
          vault_summary: data.vault_summary ?? null,
          memory_count: memories.length,
          last_accessed: data.last_accessed ?? null,
        });
      } catch { /* skip */ }
    }

    return sections.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get or create a section by name within a module.
   */
  getOrCreateSection(moduleName: string, sectionName: string, description: string = ''): Section {
    const existing = this.listSections(moduleName).find(s => s.name === sectionName);
    if (existing) return existing;
    return this.createSection(moduleName, sectionName, description);
  }

  // ─── Entries ───────────────────────────────────────────────────────────────

  /**
   * Add an entry — stores verbatim content and registers it in the KG.
   * An entry can be a file path or a KG memory ID.
   */
  addEntry(
    moduleName: string,
    sectionName: string,
    category: CategoryType,
    filePath: string,
    content: string,
    contentHash?: string
  ): { entry: Entry; memory: Memory } {
    const section = this.getOrCreateSection(moduleName, sectionName);
    const hash = contentHash ?? this.hashContent(content);

    // Register entry in KG
    const entry = this.kg.addEntry(moduleName, sectionName, category, filePath, hash);

    // Store memory in KG
    const memoryType = this.inferMemoryType(category, content);
    const importance = this.calculateImportance(content);

    const memory = this.kg.addMemory(
      entry.entry_id,
      content,
      memoryType,
      sectionName,
      moduleName,
      null, // summary — filled by compaction later
      importance
    );

    return { entry, memory };
  }

  /**
   * Get entries by module + section + category.
   */
  getEntries(moduleName: string, sectionName?: string, category?: CategoryType): Entry[] {
    const memories = this.kg.getMemoriesByStructure(moduleName, sectionName, category);
    const entryIds = [...new Set(memories.map(m => m.entry_id))];

    return entryIds
      .map(id => {
        const rows = (this.kg as any).db?.prepare('SELECT * FROM entries WHERE entry_id = ?').get(id) as Entry | undefined;
        return rows;
      })
      .filter(Boolean) as Entry[];
  }

  // ─── Vaults ───────────────────────────────────────────────────────────────

  /**
   * Create or update a vault summary for a section.
   * A vault summarizes one or more entries, pointing back to the originals.
   * 
   * This is the key structure insight: store verbatim in entries, summaries in vaults.
   * Agent can always drill from vault → entry for the full story.
   */
  upsertVault(
    moduleName: string,
    sectionName: string,
    category: CategoryType,
    summary: string,
    sourceEntryIds: string[]
  ): Vault {
    const section = this.getOrCreateSection(moduleName, sectionName);

    const vaultMeta = {
      id: uuidv4(),
      section_id: section.id,
      module_id: (this.getModule(moduleName))?.id ?? '',
      category,
      summary,
      source_entry_ids: sourceEntryIds,
      importance: 0.7,
      created_at: Date.now(),
      last_accessed: Date.now(),
    };

    const vaultFile = path.join(this.structureDir, `vault-${moduleName}-${sectionName}-${category}.json`);
    fs.writeFileSync(vaultFile, JSON.stringify(vaultMeta, null, 2), 'utf-8');

    return {
      id: vaultMeta.id,
      section_id: vaultMeta.section_id,
      module_id: vaultMeta.module_id,
      category,
      summary,
      source_entry_ids: sourceEntryIds,
      importance: vaultMeta.importance,
      created_at: vaultMeta.created_at,
      last_accessed: vaultMeta.last_accessed,
    };
  }

  /**
   * Get all vaults for a section.
   */
  getVaults(moduleName: string, sectionName: string): Vault[] {
    const vaults: Vault[] = [];
    if (!fs.existsSync(this.structureDir)) return vaults;

    const prefix = `vault-${moduleName}-${sectionName}-`;
    for (const file of fs.readdirSync(this.structureDir)) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.structureDir, file), 'utf-8'));
        vaults.push({
          id: data.id,
          section_id: data.section_id,
          module_id: data.module_id,
          category: data.category as CategoryType,
          summary: data.summary,
          source_entry_ids: data.source_entry_ids ?? [],
          importance: data.importance ?? 0.5,
          created_at: data.created_at,
          last_accessed: data.last_accessed ?? null,
        });
      } catch { /* skip */ }
    }

    return vaults;
  }

  // ─── Bridges ───────────────────────────────────────────────────────────────

  /**
   * Create a bridge — a connection between two modules through a shared section name.
   * Example: both "chris" and "athena" modules have a "memory-stack" section.
   * A bridge connects them so the agent can traverse from one to the other.
   */
  createBridge(fromModule: string, toModule: string, sectionName: string, description: string = ''): Bridge {
    const bridgeMeta = {
      id: uuidv4(),
      from_module: fromModule,
      to_module: toModule,
      section_name: sectionName,
      description,
      memory_count: 0,
    };

    const bridgeFile = path.join(this.structureDir, `bridge-${fromModule}-${toModule}-${sectionName}.json`);
    fs.writeFileSync(bridgeFile, JSON.stringify(bridgeMeta, null, 2), 'utf-8');

    return {
      id: bridgeMeta.id,
      from_module: fromModule,
      to_module: toModule,
      section_name: sectionName,
      description,
      memory_count: 0,
    };
  }

  /**
   * Find all bridges for a module.
   */
  findBridges(moduleName: string): Bridge[] {
    const bridges: Bridge[] = [];
    if (!fs.existsSync(this.structureDir)) return bridges;

    for (const file of fs.readdirSync(this.structureDir)) {
      if (!file.startsWith('bridge-') || !file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.structureDir, file), 'utf-8'));
        if (data.from_module === moduleName || data.to_module === moduleName) {
          bridges.push({
            id: data.id,
            from_module: data.from_module,
            to_module: data.to_module,
            section_name: data.section_name,
            description: data.description ?? '',
            memory_count: data.memory_count ?? 0,
          });
        }
      } catch { /* skip */ }
    }

    return bridges;
  }

  /**
   * Find sections that exist in multiple modules (potential bridges).
   */
  findPotentialBridges(): { sectionName: string; modules: string[] }[] {
    const moduleSections = new Map<string, Set<string>>();

    for (const module of this.listModules()) {
      for (const section of this.listSections(module.name)) {
        if (!moduleSections.has(section.name)) {
          moduleSections.set(section.name, new Set());
        }
        moduleSections.get(section.name)!.add(module.name);
      }
    }

    return Array.from(moduleSections.entries())
      .filter(([, modules]) => modules.size > 1)
      .map(([sectionName, modules]) => ({ sectionName, modules: Array.from(modules) }));
  }

  // ─── Navigation ────────────────────────────────────────────────────────────

  /**
   * Walk the structure from a starting module, optionally filtering by category.
   * Returns a structured tour through modules → sections → vaults → entries.
   */
  walk(moduleName?: string, category?: CategoryType): {
    modules: Module[];
    sections: Section[];
    vaults: Vault[];
    totalMemories: number;
  } {
    const modules = moduleName ? [this.getModule(moduleName)].filter(Boolean) as Module[] : this.listModules();
    const sections: Section[] = [];
    const vaults: Vault[] = [];
    let totalMemories = 0;

    for (const module of modules) {
      for (const section of this.listSections(module.name)) {
        sections.push(section);
        for (const vault of this.getVaults(module.name, section.name)) {
          if (!category || vault.category === category) {
            vaults.push(vault);
          }
        }
        const memories = this.kg.getMemoriesByStructure(module.name, section.name);
        totalMemories += memories.length;
      }
    }

    return { modules, sections, vaults, totalMemories };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private hashContent(content: string): string {
    // Simple non-crypto hash for content fingerprinting
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  private inferMemoryType(category: CategoryType, content: string): Memory['memory_type'] {
    const lower = content.toLowerCase();
    if (lower.includes('decided') || lower.includes('chose') || lower.includes('agreed')) return 'decision';
    if (lower.includes('learned') || lower.includes('discovered') || lower.includes('found')) return 'discovery';
    if (lower.includes('preference') || lower.includes('likes') || lower.includes('prefers')) return 'preference';
    if (lower.includes('should') || lower.includes('recommend') || lower.includes('suggest')) return 'advice';
    if (lower.includes('happened') || lower.includes('occurred') || lower.includes('event')) return 'event';
    return category === 'facts' ? 'fact' : 'conversation';
  }

  private calculateImportance(content: string): number {
    // Simple heuristic: longer content with specific details = higher importance
    let score = 0.3;
    if (content.length > 500) score += 0.2;
    if (/[A-Z][a-z]+/.test(content)) score += 0.1; // Has proper nouns
    if (/\d+/.test(content)) score += 0.1; // Has numbers
    if (/decided|chose|learned|discovered/i.test(content)) score += 0.2;
    return Math.min(1.0, score);
  }

  /**
   * Format structure overview as a readable string.
   */
  overview(): string {
    const modules = this.listModules();
    let output = '# AthenaMem Core Structure Overview\n\n';

    if (modules.length === 0) {
      return output + 'No modules created yet.\n';
    }

    for (const module of modules) {
      output += `## ${module.name} (${module.section_count} sections, ${module.memory_count} memories)\n`;
      if (module.description) output += `${module.description}\n`;

      const sections = this.listSections(module.name);
      for (const section of sections) {
        const bridges = this.findBridges(module.name).filter(b => b.section_name === section.name);
        const bridgeStr = bridges.length > 0 ? ` [${bridges.length} bridge(s)]` : '';
        output += `  ### ${section.name}${bridgeStr} (${section.memory_count} memories)\n`;
        if (section.vault_summary) {
          output += `  ${section.vault_summary.substring(0, 120)}...\n`;
        }
      }
      output += '\n';
    }

    return output;
  }
}
