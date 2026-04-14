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
import { KnowledgeGraph, Memory, Drawer, HallType } from './kg.js';
export interface Wing {
    id: string;
    name: string;
    description: string;
    created_at: number;
    room_count: number;
    memory_count: number;
}
export interface Room {
    id: string;
    wing_id: string;
    name: string;
    description: string;
    closet_summary: string | null;
    memory_count: number;
    last_accessed: number | null;
}
export interface Closet {
    id: string;
    room_id: string;
    wing_id: string;
    hall: HallType;
    summary: string;
    source_drawer_ids: string[];
    importance: number;
    created_at: number;
    last_accessed: number | null;
}
export interface Tunnel {
    id: string;
    from_wing: string;
    to_wing: string;
    room_name: string;
    description: string;
    memory_count: number;
}
export declare class Palace {
    private kg;
    private palaceDir;
    constructor(kg: KnowledgeGraph, palaceDir: string);
    private ensureDir;
    /**
     * Create or get a wing.
     * A wing is the top-level container — typically one per person, agent, or project.
     */
    createWing(name: string, description?: string): Wing;
    getOrCreateWing(name: string, description?: string): Wing;
    /**
     * List all wings.
     */
    listWings(): Wing[];
    /**
     * Get a wing by name.
     */
    getWing(name: string): Wing | null;
    /**
     * Create a room within a wing.
     * A room is a topic or area of focus.
     */
    createRoom(wingName: string, roomName: string, description?: string): Room;
    /**
     * List all rooms within a wing.
     */
    listRooms(wingName: string): Room[];
    /**
     * Get or create a room by name within a wing.
     */
    getOrCreateRoom(wingName: string, roomName: string, description?: string): Room;
    /**
     * Add a drawer — stores verbatim content and registers it in the KG.
     * A drawer can be a file path or a KG memory ID.
     */
    addDrawer(wingName: string, roomName: string, hall: HallType, filePath: string, content: string, contentHash?: string): {
        drawer: Drawer;
        memory: Memory;
    };
    /**
     * Get drawers by wing + room + hall.
     */
    getDrawers(wingName: string, roomName?: string, hall?: HallType): Drawer[];
    /**
     * Create or update a closet summary for a room.
     * A closet summarizes one or more drawers, pointing back to the originals.
     *
     * This is the key palace insight: store verbatim in drawers, summaries in closets.
     * Agent can always drill from closet → drawer for the full story.
     */
    upsertCloset(wingName: string, roomName: string, hall: HallType, summary: string, sourceDrawerIds: string[]): Closet;
    /**
     * Get all closets for a room.
     */
    getClosets(wingName: string, roomName: string): Closet[];
    /**
     * Create a tunnel — a connection between two wings through a shared room name.
     * Example: both "chris" and "athena" wings have a "memory-stack" room.
     * A tunnel connects them so the agent can traverse from one to the other.
     */
    createTunnel(fromWing: string, toWing: string, roomName: string, description?: string): Tunnel;
    /**
     * Find all tunnels for a wing.
     */
    findTunnels(wingName: string): Tunnel[];
    /**
     * Find rooms that exist in multiple wings (potential tunnels).
     */
    findPotentialTunnels(): {
        roomName: string;
        wings: string[];
    }[];
    /**
     * Walk the palace from a starting wing, optionally filtering by hall.
     * Returns a structured tour through wings → rooms → closets → drawers.
     */
    walk(wingName?: string, hall?: HallType): {
        wings: Wing[];
        rooms: Room[];
        closets: Closet[];
        totalMemories: number;
    };
    private hashContent;
    private inferMemoryType;
    private calculateImportance;
    /**
     * Format palace overview as a readable string.
     */
    overview(): string;
}
//# sourceMappingURL=palace.d.ts.map