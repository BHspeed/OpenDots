import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolDefinition, type JSONSchema } from '@tanstack/ai';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Local MCP servers (files, vision, PC control, ...) shared by every Dot.
// Declared in mcp.servers.json so new capabilities plug in without code changes.
const serverSchema = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({ url: z.url(), enabled: z.boolean().default(true) }),
]);
const configSchema = z.record(z.string().regex(/^[a-z0-9_-]+$/i), serverSchema);
export type McpServers = z.infer<typeof configSchema>;

export function loadMcpServers(path = 'mcp.servers.json'): McpServers {
  if (!existsSync(path)) return {};
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

interface Connected {
  client: Client;
  tools: { name: string; description?: string; inputSchema: unknown }[];
}

export class McpTools {
  private connections = new Map<string, Promise<Connected>>();
  constructor(private servers: McpServers) {}
  get configured() {
    return Object.values(this.servers).some((server) => server.enabled);
  }
  private connect(name: string): Promise<Connected> {
    let pending = this.connections.get(name);
    if (pending) return pending;
    const server = this.servers[name];
    pending = (async () => {
      const client = new Client({ name: 'opendots', version: '0.1.0' });
      const transport =
        'url' in server
          ? new StreamableHTTPClientTransport(new URL(server.url))
          : new StdioClientTransport({
              command: resolve(server.command),
              args: server.args,
              env: {
                ...(process.env as Record<string, string>),
                ...server.env,
              },
              stderr: 'ignore',
            });
      transport.onclose = () => this.connections.delete(name);
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { client, tools };
    })();
    pending.catch(() => this.connections.delete(name));
    this.connections.set(name, pending);
    return pending;
  }
  // Tool names are prefixed with the server name to keep them unique.
  async tools(
    check: () => void,
    signal: AbortSignal,
    allow: (server: string, tool: string) => boolean = () => true,
  ) {
    const enabled = Object.entries(this.servers).filter(([, s]) => s.enabled);
    const results = await Promise.allSettled(
      enabled.map(async ([name]) => ({ name, ...(await this.connect(name)) })),
    );
    return results.flatMap((result) => {
      if (result.status === 'rejected') {
        console.warn('MCP server unavailable:', String(result.reason));
        return [];
      }
      const { name, client, tools } = result.value;
      return tools
        .filter((tool) => allow(name, tool.name))
        .map((tool) =>
          toolDefinition({
            name: `${name}__${tool.name}`,
            description: tool.description ?? tool.name,
            inputSchema: tool.inputSchema as JSONSchema,
          }).server(async (input) => {
            check();
            const response = await client.callTool(
              {
                name: tool.name,
                arguments: (input ?? {}) as Record<string, unknown>,
              },
              undefined,
              // Confirmation dialogs wait on the owner, so allow a long call.
              { signal, timeout: 600_000 },
            );
            const text = (response.content as { type: string; text?: string }[])
              ?.filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
            if (response.isError) throw new Error(text || 'Tool failed.');
            return response.structuredContent ?? text;
          }),
        );
    });
  }
  /** Names of configured servers other than the built-in local tools. */
  extraServers() {
    return Object.entries(this.servers)
      .filter(([name, server]) => server.enabled && name !== 'localtools')
      .map(([name]) => name);
  }
  async close() {
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(all.map(async (c) => (await c).client.close()));
  }
}
