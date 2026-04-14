/**
 * AthenaMem Palace — Wings, Rooms, Closets, Drawers
 *
 * The palace is the top-level organizational metaphor for all memory.
 * Inspired by MemPalace's hierarchical approach, extended with halls and tunnels.
 *
 * Memory is organized as:
 * - WING: A person, agent, project, or concept (top-level container)
 * - ROOM: A topic or area within a wing
 * - CLOSET: A summary pointing to one or more drawers
 * - DRAWER: A verbatim record (file or KG entry)
 * - HALL: A category within a room (facts, events, discoveries, preferences, advice)
 * - TUNNEL: A cross-wing connection (same room name bridges two wings)
 */
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
// ─── Palace Class ─────────────────────────────────────────────────────────────
export class Palace {
    kg;
    palaceDir;
    constructor(kg, palaceDir) {
        this.kg = kg;
        this.palaceDir = palaceDir;
        this.ensureDir();
    }
    ensureDir() {
        if (!fs.existsSync(this.palaceDir)) {
            fs.mkdirSync(this.palaceDir, { recursive: true });
        }
    }
    // ─── Wings ─────────────────────────────────────────────────────────────────
    /**
     * Create or get a wing.
     * A wing is the top-level container — typically one per person, agent, or project.
     */
    createWing(name, description = '') {
        const entity = this.kg.addEntity(name, 'agent', { description, wing_name: name });
        const now = Date.now();
        const wingMeta = {
            id: uuidv4(),
            name,
            description,
            created_at: now,
            entity_id: entity.id,
        };
        const wingFile = path.join(this.palaceDir, `wing-${name}.json`);
        if (!fs.existsSync(wingFile)) {
            fs.writeFileSync(wingFile, JSON.stringify(wingMeta, null, 2), 'utf-8');
        }
        return {
            id: wingMeta.id,
            name,
            description,
            created_at: now,
            room_count: 0,
            memory_count: 0,
        };
    }
    getOrCreateWing(name, description = '') {
        const existing = this.getWing(name);
        if (existing)
            return existing;
        return this.createWing(name, description);
    }
    deleteWing(name) {
        const wing = this.getWing(name);
        if (!wing) {
            return { deleted: false, rooms_removed: 0, memories_invalidated: 0 };
        }
        const rooms = this.listRooms(name);
        const memories = this.kg.getMemoriesByPalace(name);
        for (const memory of memories) {
            this.kg.invalidateMemory(memory.id, 'user_deleted');
        }
        const wingEntity = this.kg.getEntityByName(name);
        if (wingEntity) {
            this.kg.invalidateEntity(wingEntity.id);
        }
        const wingFile = path.join(this.palaceDir, `wing-${name}.json`);
        if (fs.existsSync(wingFile))
            fs.unlinkSync(wingFile);
        for (const room of rooms) {
            const roomFile = path.join(this.palaceDir, `room-${name}-${room.name}.json`);
            if (fs.existsSync(roomFile))
                fs.unlinkSync(roomFile);
        }
        return { deleted: true, rooms_removed: rooms.length, memories_invalidated: memories.length };
    }
    /**
     * List all wings.
     */
    listWings() {
        const wings = [];
        if (!fs.existsSync(this.palaceDir))
            return wings;
        for (const file of fs.readdirSync(this.palaceDir)) {
            if (!file.startsWith('wing-') || !file.endsWith('.json'))
                continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.palaceDir, file), 'utf-8'));
                const rooms = this.listRooms(data.name);
                const memories = this.kg.getMemoriesByPalace(data.name);
                wings.push({
                    id: data.id,
                    name: data.name,
                    description: data.description ?? '',
                    created_at: data.created_at,
                    room_count: rooms.length,
                    memory_count: memories.length,
                });
            }
            catch { /* skip malformed files */ }
        }
        return wings.sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * Get a wing by name.
     */
    getWing(name) {
        const file = path.join(this.palaceDir, `wing-${name}.json`);
        if (!fs.existsSync(file))
            return null;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const rooms = this.listRooms(name);
        const memories = this.kg.getMemoriesByPalace(name);
        return {
            id: data.id,
            name: data.name,
            description: data.description ?? '',
            created_at: data.created_at,
            room_count: rooms.length,
            memory_count: memories.length,
        };
    }
    // ─── Rooms ─────────────────────────────────────────────────────────────────
    /**
     * Create a room within a wing.
     * A room is a topic or area of focus.
     */
    createRoom(wingName, roomName, description = '') {
        const wing = this.getWing(wingName);
        if (!wing)
            throw new Error(`Wing '${wingName}' does not exist`);
        const roomEntity = this.kg.addEntity(`${wingName}::${roomName}`, 'topic', { description, wing: wingName });
        const roomMeta = {
            id: roomEntity.id,
            wing_id: wing.id,
            name: roomName,
            description,
            closet_summary: null,
            created_at: Date.now(),
        };
        const roomFile = path.join(this.palaceDir, `room-${wingName}-${roomName}.json`);
        fs.writeFileSync(roomFile, JSON.stringify(roomMeta, null, 2), 'utf-8');
        return {
            id: roomMeta.id,
            wing_id: wing.id,
            name: roomName,
            description,
            closet_summary: null,
            memory_count: 0,
            last_accessed: null,
        };
    }
    /**
     * List all rooms within a wing.
     */
    listRooms(wingName) {
        const rooms = [];
        if (!fs.existsSync(this.palaceDir))
            return rooms;
        for (const file of fs.readdirSync(this.palaceDir)) {
            if (!file.startsWith(`room-${wingName}-`) || !file.endsWith('.json'))
                continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.palaceDir, file), 'utf-8'));
                const memories = this.kg.getMemoriesByPalace(wingName, data.name);
                rooms.push({
                    id: data.id,
                    wing_id: data.wing_id,
                    name: data.name,
                    description: data.description ?? '',
                    closet_summary: data.closet_summary ?? null,
                    memory_count: memories.length,
                    last_accessed: data.last_accessed ?? null,
                });
            }
            catch { /* skip */ }
        }
        return rooms.sort((a, b) => a.name.localeCompare(b.name));
    }
    /**
     * Get or create a room by name within a wing.
     */
    getOrCreateRoom(wingName, roomName, description = '') {
        const existing = this.listRooms(wingName).find(r => r.name === roomName);
        if (existing)
            return existing;
        return this.createRoom(wingName, roomName, description);
    }
    // ─── Drawers ───────────────────────────────────────────────────────────────
    /**
     * Add a drawer — stores verbatim content and registers it in the KG.
     * A drawer can be a file path or a KG memory ID.
     */
    addDrawer(wingName, roomName, hall, filePath, content, contentHash) {
        this.getOrCreateWing(wingName);
        const room = this.getOrCreateRoom(wingName, roomName);
        const hash = contentHash ?? this.hashContent(content);
        // Register drawer in KG
        const drawer = this.kg.addDrawer(wingName, roomName, hall, filePath, hash);
        // Store memory in KG
        const memoryType = this.inferMemoryType(hall, content);
        const importance = this.calculateImportance(content);
        const memory = this.kg.addMemory(drawer.drawer_id, content, memoryType, roomName, wingName, null, // summary — filled by compaction later
        importance);
        return { drawer, memory };
    }
    /**
     * Get drawers by wing + room + hall.
     */
    getDrawers(wingName, roomName, hall) {
        const memories = this.kg.getMemoriesByPalace(wingName, roomName, hall);
        const drawerIds = [...new Set(memories.map(m => m.drawer_id))];
        return drawerIds
            .map(id => {
            const rows = this.kg.db?.prepare('SELECT * FROM drawers WHERE drawer_id = ?').get(id);
            return rows;
        })
            .filter(Boolean);
    }
    // ─── Closets ───────────────────────────────────────────────────────────────
    /**
     * Create or update a closet summary for a room.
     * A closet summarizes one or more drawers, pointing back to the originals.
     *
     * This is the key palace insight: store verbatim in drawers, summaries in closets.
     * Agent can always drill from closet → drawer for the full story.
     */
    upsertCloset(wingName, roomName, hall, summary, sourceDrawerIds) {
        const room = this.getOrCreateRoom(wingName, roomName);
        const closetMeta = {
            id: uuidv4(),
            room_id: room.id,
            wing_id: (this.getWing(wingName))?.id ?? '',
            hall,
            summary,
            source_drawer_ids: sourceDrawerIds,
            importance: 0.7,
            created_at: Date.now(),
            last_accessed: Date.now(),
        };
        const closetFile = path.join(this.palaceDir, `closet-${wingName}-${roomName}-${hall}.json`);
        fs.writeFileSync(closetFile, JSON.stringify(closetMeta, null, 2), 'utf-8');
        return {
            id: closetMeta.id,
            room_id: closetMeta.room_id,
            wing_id: closetMeta.wing_id,
            hall,
            summary,
            source_drawer_ids: sourceDrawerIds,
            importance: closetMeta.importance,
            created_at: closetMeta.created_at,
            last_accessed: closetMeta.last_accessed,
        };
    }
    /**
     * Get all closets for a room.
     */
    getClosets(wingName, roomName) {
        const closets = [];
        if (!fs.existsSync(this.palaceDir))
            return closets;
        const prefix = `closet-${wingName}-${roomName}-`;
        for (const file of fs.readdirSync(this.palaceDir)) {
            if (!file.startsWith(prefix) || !file.endsWith('.json'))
                continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.palaceDir, file), 'utf-8'));
                closets.push({
                    id: data.id,
                    room_id: data.room_id,
                    wing_id: data.wing_id,
                    hall: data.hall,
                    summary: data.summary,
                    source_drawer_ids: data.source_drawer_ids ?? [],
                    importance: data.importance ?? 0.5,
                    created_at: data.created_at,
                    last_accessed: data.last_accessed ?? null,
                });
            }
            catch { /* skip */ }
        }
        return closets;
    }
    // ─── Tunnels ───────────────────────────────────────────────────────────────
    /**
     * Create a tunnel — a connection between two wings through a shared room name.
     * Example: both "chris" and "athena" wings have a "memory-stack" room.
     * A tunnel connects them so the agent can traverse from one to the other.
     */
    createTunnel(fromWing, toWing, roomName, description = '') {
        const tunnelMeta = {
            id: uuidv4(),
            from_wing: fromWing,
            to_wing: toWing,
            room_name: roomName,
            description,
            memory_count: 0,
        };
        const tunnelFile = path.join(this.palaceDir, `tunnel-${fromWing}-${toWing}-${roomName}.json`);
        fs.writeFileSync(tunnelFile, JSON.stringify(tunnelMeta, null, 2), 'utf-8');
        return {
            id: tunnelMeta.id,
            from_wing: fromWing,
            to_wing: toWing,
            room_name: roomName,
            description,
            memory_count: 0,
        };
    }
    /**
     * Find all tunnels for a wing.
     */
    findTunnels(wingName) {
        const tunnels = [];
        if (!fs.existsSync(this.palaceDir))
            return tunnels;
        for (const file of fs.readdirSync(this.palaceDir)) {
            if (!file.startsWith('tunnel-') || !file.endsWith('.json'))
                continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.palaceDir, file), 'utf-8'));
                if (data.from_wing === wingName || data.to_wing === wingName) {
                    tunnels.push({
                        id: data.id,
                        from_wing: data.from_wing,
                        to_wing: data.to_wing,
                        room_name: data.room_name,
                        description: data.description ?? '',
                        memory_count: data.memory_count ?? 0,
                    });
                }
            }
            catch { /* skip */ }
        }
        return tunnels;
    }
    /**
     * Find rooms that exist in multiple wings (potential tunnels).
     */
    findPotentialTunnels() {
        const wingRooms = new Map();
        for (const wing of this.listWings()) {
            for (const room of this.listRooms(wing.name)) {
                if (!wingRooms.has(room.name)) {
                    wingRooms.set(room.name, new Set());
                }
                wingRooms.get(room.name).add(wing.name);
            }
        }
        return Array.from(wingRooms.entries())
            .filter(([, wings]) => wings.size > 1)
            .map(([roomName, wings]) => ({ roomName, wings: Array.from(wings) }));
    }
    // ─── Navigation ────────────────────────────────────────────────────────────
    /**
     * Walk the palace from a starting wing, optionally filtering by hall.
     * Returns a structured tour through wings → rooms → closets → drawers.
     */
    walk(wingName, hall) {
        const wings = wingName ? [this.getWing(wingName)].filter(Boolean) : this.listWings();
        const rooms = [];
        const closets = [];
        let totalMemories = 0;
        for (const wing of wings) {
            for (const room of this.listRooms(wing.name)) {
                rooms.push(room);
                for (const closet of this.getClosets(wing.name, room.name)) {
                    if (!hall || closet.hall === hall) {
                        closets.push(closet);
                    }
                }
                const memories = this.kg.getMemoriesByPalace(wing.name, room.name);
                totalMemories += memories.length;
            }
        }
        return { wings, rooms, closets, totalMemories };
    }
    // ─── Helpers ────────────────────────────────────────────────────────────────
    hashContent(content) {
        // Simple non-crypto hash for content fingerprinting
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16);
    }
    inferMemoryType(hall, content) {
        const lower = content.toLowerCase();
        if (lower.includes('decided') || lower.includes('chose') || lower.includes('agreed'))
            return 'decision';
        if (lower.includes('learned') || lower.includes('discovered') || lower.includes('found'))
            return 'discovery';
        if (lower.includes('preference') || lower.includes('likes') || lower.includes('prefers'))
            return 'preference';
        if (lower.includes('should') || lower.includes('recommend') || lower.includes('suggest'))
            return 'advice';
        if (lower.includes('happened') || lower.includes('occurred') || lower.includes('event'))
            return 'event';
        return hall === 'facts' ? 'fact' : 'conversation';
    }
    calculateImportance(content) {
        // Simple heuristic: longer content with specific details = higher importance
        let score = 0.3;
        if (content.length > 500)
            score += 0.2;
        if (/[A-Z][a-z]+/.test(content))
            score += 0.1; // Has proper nouns
        if (/\d+/.test(content))
            score += 0.1; // Has numbers
        if (/decided|chose|learned|discovered/i.test(content))
            score += 0.2;
        return Math.min(1.0, score);
    }
    /**
     * Format palace overview as a readable string.
     */
    overview() {
        const wings = this.listWings();
        let output = '# AthenaMem Palace Overview\n\n';
        if (wings.length === 0) {
            return output + 'No wings created yet.\n';
        }
        for (const wing of wings) {
            output += `## ${wing.name} (${wing.room_count} rooms, ${wing.memory_count} memories)\n`;
            if (wing.description)
                output += `${wing.description}\n`;
            const rooms = this.listRooms(wing.name);
            for (const room of rooms) {
                const tunnels = this.findTunnels(wing.name).filter(t => t.room_name === room.name);
                const tunnelStr = tunnels.length > 0 ? ` [${tunnels.length} tunnel(s)]` : '';
                output += `  ### ${room.name}${tunnelStr} (${room.memory_count} memories)\n`;
                if (room.closet_summary) {
                    output += `  ${room.closet_summary.substring(0, 120)}...\n`;
                }
            }
            output += '\n';
        }
        return output;
    }
}
//# sourceMappingURL=palace.js.map