/**
 * OpenClaw Plugin SDK Type Stubs
 * Provides TypeScript declarations for the openclaw/plugin-sdk/* modules.
 */

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { Type } from "@sinclair/typebox";

  export function definePluginEntry(opts: {
    id: string;
    name: string;
    description: string;
    kind?: string;
    configSchema?: Record<string, unknown>;
    register: (api: OpenClawPluginApi) => void;
  }): {
    id: string;
    name: string;
    description: string;
    configSchema: Record<string, unknown>;
    register: (api: OpenClawPluginApi) => void;
  };

  export type OpenClawPluginApi = {
    readonly pluginConfig: Record<string, unknown> | undefined;
    readonly registrationMode: string;
    registerHook(event: string, handler: HookHandler, opts?: Record<string, unknown>): void;
    registerTool(tool: AgentTool, opts?: Record<string, unknown>): void;
    registerService(service: unknown): void;
    registerGatewayMethod(name: string, handler: unknown): void;
    registerCli(registrar: unknown, opts?: Record<string, unknown>): void;
  };

  export type AgentTool = {
    name: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>;
  };

  export type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  };

  export type HookHandler = (event: HookEvent) => Promise<void>;

  export type HookEvent = {
    readonly sessionId?: string;
    readonly agentId?: string;
    readonly toolCallId?: string;
    [key: string]: unknown;
  };
}
