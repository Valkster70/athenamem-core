/**
 * AthenaMem OpenClaw Plugin — Entry Point
 * Wires all 19 MCP tools + lifecycle hooks into the OpenClaw gateway.
 */
declare const athenamem: {
    id: string;
    name: string;
    description: string;
    configSchema: Record<string, unknown>;
    register: (api: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginApi) => void;
};
export default athenamem;
//# sourceMappingURL=index.d.ts.map