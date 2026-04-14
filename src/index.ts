/**
 * AthenaMem OpenClaw Plugin — Entry Point
 * Wires all 19 MCP tools + lifecycle hooks into the OpenClaw gateway.
 */

import { Type } from "@sinclair/typebox";
import { homedir } from "os";
import * as path from "path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  init,
  getContext,
  setSession,
  toolStatus,
  toolListWings,
  toolListRooms,
  toolSearch,
  toolGetAaakSpec,
  toolAddDrawer,
  toolDeleteDrawer,
  toolKgQuery,
  toolKgAdd,
  toolKgInvalidate,
  toolKgTimeline,
  toolCheckFacts,
  toolResolveConflict,
  toolDiaryWrite,
  toolDiaryRead,
  toolTraverse,
  toolFindTunnels,
  toolRecall,
  toolCreateWing,
  toolCreateRoom,
} from "./plugin/server.js";

// ─── Tool parameter schemas ─────────────────────────────────────────────────────

const EmptySchema = Type.Object({});

const ListRoomsSchema = Type.Object({
  wingName: Type.String(),
});

const SearchSchema = Type.Object({
  query: Type.String(),
  wing: Type.Optional(Type.String()),
  room: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
});

const AddDrawerSchema = Type.Object({
  wingName: Type.String(),
  roomName: Type.String(),
  hall: Type.String(),
  content: Type.String(),
  filePath: Type.Optional(Type.String()),
});

const DeleteDrawerSchema = Type.Object({
  drawerId: Type.String(),
});

const KgQuerySchema = Type.Object({
  entityId: Type.Optional(Type.String()),
  asOf: Type.Optional(Type.Number()),
});

const KgAddSchema = Type.Object({
  subject: Type.String(),
  predicate: Type.String(),
  object: Type.String(),
  confidence: Type.Optional(Type.Number()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const KgInvalidateSchema = Type.Object({
  entityId: Type.String(),
  ended: Type.Optional(Type.Number()),
});

const KgTimelineSchema = Type.Object({
  entityId: Type.String(),
});

const CheckFactsSchema = Type.Object({
  text: Type.String(),
});

const ResolveConflictSchema = Type.Object({
  memoryId: Type.String(),
  resolution: Type.Union([
    Type.Literal("keep_new"),
    Type.Literal("keep_old"),
    Type.Literal("merge"),
    Type.Literal("invalidate_old"),
  ]),
});

const DiaryWriteSchema = Type.Object({
  agentName: Type.String(),
  entryType: Type.String(),
  content: Type.String(),
});

const DiaryReadSchema = Type.Object({
  agentName: Type.String(),
  limit: Type.Optional(Type.Number()),
});

const TraverseSchema = Type.Object({
  wingName: Type.String(),
  roomName: Type.String(),
});

const RecallSchema = Type.Object({
  query: Type.String(),
  limit: Type.Optional(Type.Number()),
});

// ─── Plugin definition ─────────────────────────────────────────────────────────

const athenamem = definePluginEntry({
  id: "athenamem",
  name: "AthenaMem",
  description:
    "Biomimetic memory stack — palace architecture, WAL enforcement, " +
    "contradiction detection, DAG compaction, cross-system recall.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      data_dir: { type: "string", default: "~/.openclaw/workspace/athenamem/data" },
      palace_dir: { type: "string", default: "~/.openclaw/workspace/athenamem/palace" },
      compact_on_flush: { type: "boolean", default: true },
      contradiction_check: { type: "boolean", default: true },
      auto_wal: { type: "boolean", default: true },
      qmd_path: { type: "string", default: "~/.cache/qmd" },
      clawvault_path: { type: "string", default: "~/.openclaw/workspace/memory" },
      hindsight_url: { type: "string", default: "http://127.0.0.1:8888" },
      mnemo_url: { type: "string", default: "http://127.0.0.1:50001" },
    },
  },

  register(api) {
    // Expand ~ to home directory
    const expandPath = (p: string) => p && p.startsWith("~") ? path.join(homedir(), p.slice(1)) : p;

    const cfg = api.pluginConfig as Record<string, unknown> | undefined;

    // ── Initialize AthenaMem core ──────────────────────────────────────────
    init({
      data_dir: expandPath(String(cfg?.data_dir ?? "~/.openclaw/workspace/athenamem/data")),
      palace_dir: expandPath(String(cfg?.palace_dir ?? "~/.openclaw/workspace/athenamem/palace")),
      compact_on_flush: Boolean(cfg?.compact_on_flush ?? true),
      contradiction_check: Boolean(cfg?.contradiction_check ?? true),
      auto_wal: Boolean(cfg?.auto_wal ?? true),
      qmd_path: expandPath(String(cfg?.qmd_path ?? "~/.cache/qmd")),
      clawvault_path: expandPath(String(cfg?.clawvault_path ?? "~/.openclaw/workspace/memory")),
      hindsight_url: String(cfg?.hindsight_url ?? "http://127.0.0.1:8888"),
      mnemo_url: String(cfg?.mnemo_url ?? "http://127.0.0.1:50001"),
    });

    // ── Lifecycle hooks ───────────────────────────────────────────────────

    // Bind session to AthenaMem on agent start
    api.registerHook("before_agent_start", async (event) => {
      if (event.sessionId) {
        setSession(event.sessionId, (event.agentId as string) ?? "unknown");
      }
    });

    // WAL checkpoint after every tool call
    api.registerHook("after_tool_call", async (event) => {
      if (Boolean(cfg?.auto_wal ?? true)) {
        try {
          const c = getContext();
          c.wal.checkpoint({ session_state: `tool:${event.toolCallId as string}` });
        } catch {
          // WAL failure is non-fatal
        }
      }
    });

    // Compaction before prompt is built (context window pressure)
    api.registerHook("before_prompt_build", async () => {
      if (Boolean(cfg?.compact_on_flush ?? true)) {
        try {
          const c = getContext();
          // Find memories older than 7 days for Level 1 compaction
          const memories = c.kg.searchMemories("", undefined, undefined, 1000);
          const oldMemories = memories.filter(m => Date.now() - m.created_at > 7 * 24 * 60 * 60 * 1000);
          if (oldMemories.length >= 3) {
            await c.compaction.compact(
              oldMemories.slice(0, 10).map(m => m.id),
              1,
              "athena",
              "memory-stack",
            );
          }
        } catch {
          // Compaction failure is non-fatal
        }
      }
    });

    // ── Register all 19 tools ──────────────────────────────────────────────

    api.registerTool({
      name: "athenamem_status",
      description: "AthenaMem L0–L4 overview: KG stats, palace wings, WAL state, compaction metrics, and AAAK spec.",
      parameters: EmptySchema,
      async execute() {
        const result = await toolStatus();
        return { content: [{ type: "text" as const, text: result }] };
      },
    });

    api.registerTool({
      name: "athenamem_list_wings",
      description: "List all palace wings with room count and memory counts.",
      parameters: EmptySchema,
      async execute() {
        const wings = await toolListWings();
        return { content: [{ type: "text" as const, text: JSON.stringify(wings, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_list_rooms",
      description: "List all rooms within a named wing.",
      parameters: ListRoomsSchema,
      async execute(_, params) {
        const rooms = await toolListRooms(String(params.wingName));
        return { content: [{ type: "text" as const, text: JSON.stringify(rooms, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_search",
      description: "Hybrid palace search with optional wing/room filters. Returns ranked results.",
      parameters: SearchSchema,
      async execute(_, params) {
        const results = await toolSearch(
          String(params.query),
          params.wing != null ? String(params.wing) : undefined,
          params.room != null ? String(params.room) : undefined,
          params.limit != null ? Number(params.limit) : 20,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_get_aaak_spec",
      description: "Returns the full AAAK dialect reference.",
      parameters: EmptySchema,
      async execute() {
        const spec = await toolGetAaakSpec();
        return { content: [{ type: "text" as const, text: spec }] };
      },
    });

    api.registerTool({
      name: "athenamem_add_drawer",
      description: "Store verbatim content in a palace drawer. Runs contradiction check if enabled.",
      parameters: AddDrawerSchema,
      async execute(_, params) {
        const result = await toolAddDrawer(
          String(params.wingName),
          String(params.roomName),
          String(params.hall) as any,
          String(params.content),
          params.filePath != null ? String(params.filePath) : undefined,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_delete_drawer",
      description: "Delete a drawer by ID. Memories are retained for KG integrity.",
      parameters: DeleteDrawerSchema,
      async execute(_, params) {
        const result = await toolDeleteDrawer(String(params.drawerId));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_kg_query",
      description: "Query KG entities and their relations, optionally as-of a point in time.",
      parameters: KgQuerySchema,
      async execute(_, params) {
        const result = await toolKgQuery(
          params.entityId != null ? String(params.entityId) : undefined,
          params.asOf != null ? Number(params.asOf) : undefined,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_kg_add",
      description: "Add a subject–predicate–object fact to the KG with confidence score.",
      parameters: KgAddSchema,
      async execute(_, params) {
        const result = await toolKgAdd(
          String(params.subject),
          String(params.predicate) as any,
          String(params.object),
          params.confidence != null ? Number(params.confidence) : 1.0,
          params.metadata != null ? (params.metadata as Record<string, unknown>) : {},
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_kg_invalidate",
      description: "Invalidate an entity as of a timestamp.",
      parameters: KgInvalidateSchema,
      async execute(_, params) {
        const result = await toolKgInvalidate(
          String(params.entityId),
          params.ended != null ? Number(params.ended) : undefined,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_kg_timeline",
      description: "Get the chronological event timeline for an entity.",
      parameters: KgTimelineSchema,
      async execute(_, params) {
        const result = await toolKgTimeline(String(params.entityId));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_check_facts",
      description: "Extract facts from text and check against KG for contradictions.",
      parameters: CheckFactsSchema,
      async execute(_, params) {
        const result = await toolCheckFacts(String(params.text));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_resolve_conflict",
      description: "Resolve a flagged contradiction.",
      parameters: ResolveConflictSchema,
      async execute(_, params) {
        const result = await toolResolveConflict(
          String(params.memoryId),
          String(params.resolution) as any,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_diary_write",
      description: "Write an AAAK diary entry for an agent.",
      parameters: DiaryWriteSchema,
      async execute(_, params) {
        const result = await toolDiaryWrite(
          String(params.agentName),
          String(params.entryType),
          String(params.content),
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_diary_read",
      description: "Read recent diary entries for an agent.",
      parameters: DiaryReadSchema,
      async execute(_, params) {
        const result = await toolDiaryRead(
          String(params.agentName),
          params.limit != null ? Number(params.limit) : 10,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_traverse",
      description: "Traverse a room and its tunnels, returning connected wings and memories.",
      parameters: TraverseSchema,
      async execute(_, params) {
        const result = await toolTraverse(String(params.wingName), String(params.roomName));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_find_tunnels",
      description: "Find rooms that bridge multiple wings.",
      parameters: EmptySchema,
      async execute() {
        const result = await toolFindTunnels();
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    api.registerTool({
      name: "athenamem_recall",
      description:
        "Deep cross-system recall — fuses palace KG + qmd + ClawVault + Hindsight + Mnemo Cortex via RRF.",
      parameters: RecallSchema,
      async execute(_, params) {
        const result = await toolRecall(
          String(params.query),
          params.limit != null ? Number(params.limit) : 30,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });


    // Create Wing Tool
    api.registerTool({
      name: "athenamem_create_wing",
      description: "Create a new wing in the palace. Required before adding rooms.",
      parameters: Type.Object({
        wingName: Type.String(),
        description: Type.Optional(Type.String()),
      }),
      async execute(_, params) {
        const desc = typeof params.description === "string" ? params.description : ""; const result = await toolCreateWing(String(params.wingName), desc);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });

    // Create Room Tool
    api.registerTool({
      name: "athenamem_create_room",
      description: "Create a new room within a wing. The wing must exist first.",
      parameters: Type.Object({
        wingName: Type.String(),
        roomName: Type.String(),
        description: Type.Optional(Type.String()),
      }),
      async execute(_, params) {
        const desc2 = typeof params.description === "string" ? params.description : "";
        const result = await toolCreateRoom(String(params.wingName), String(params.roomName), desc2);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      },
    });
  },
});

export default athenamem;
