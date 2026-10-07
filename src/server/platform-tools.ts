import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { PlatformConfig } from './platform-config.js';
import type { WorkspaceStore } from './workspace.js';
import type { Dot } from '../shared/types.js';
import { toolGroups } from '../shared/capabilities.js';

/** Delegation chains stop here so Dots cannot recurse indefinitely. */
export const maxDelegationDepth = 2;

// Platform-native tools: multi-agent delegation and long-term memory.
export function platformTools(options: {
  config: PlatformConfig;
  workspace: WorkspaceStore;
  dot: Dot;
  threadId: string;
  depth: number;
  check: () => void;
  signal: AbortSignal;
}): ToolDefinition[] {
  const { config, workspace, dot, threadId, depth, check, signal } = options;
  const granted = dot.toolGroups ?? [];
  const tools: ToolDefinition[] = [];
  if (
    granted.includes('delegation') &&
    config.delegate &&
    depth < maxDelegationDepth
  ) {
    const delegate = config.delegate;
    tools.push(
      defineTool({
        name: 'list_specialists',
        description:
          'List the other specialist Dots you can delegate to, with their roles and tool groups.',
        parameters: z.object({}),
        execute: async () => {
          check();
          return workspace
            .dots()
            .filter((other) => other.id !== dot.id)
            .map((other) => ({
              name: other.name,
              role: other.instructions.slice(0, 300),
              tools: (other.toolGroups ?? []).map(
                (group) =>
                  toolGroups[group as keyof typeof toolGroups]?.label ?? group,
              ),
              model: config.models?.forDot(other) ?? config.model,
            }));
        },
      }),
      defineTool({
        name: 'delegate_task',
        description:
          'Hand a self-contained task to another specialist Dot and wait for its answer. Include all context it needs; it cannot see this conversation. Use list_specialists first if unsure who fits.',
        parameters: z.object({
          specialist: z.string().min(1).describe('Name of the specialist Dot'),
          task: z.string().min(3).max(8000),
        }),
        execute: async ({ specialist, task }) => {
          check();
          const answer = await delegate({
            fromDot: dot,
            parentThreadId: threadId,
            specialist,
            task,
            depth: depth + 1,
            signal,
          });
          check();
          return { specialist, answer };
        },
      }),
    );
  }
  if (granted.includes('memory') && config.memory) {
    const memory = config.memory;
    tools.push(
      defineTool({
        name: 'search_memory',
        description:
          "Search long-term memory: the owner's past conversations and indexed folders. Use it when the owner refers to earlier work or files.",
        parameters: z.object({
          query: z.string().min(2).max(500),
          limit: z.number().int().min(1).max(12).optional(),
        }),
        execute: async ({ query, limit }) => {
          check();
          return { results: await memory.search(query, limit ?? 6) };
        },
      }),
      defineTool({
        name: 'index_folder',
        description:
          'Add a folder of text, notes or code to long-term memory so it can be searched later. Only changed files are re-read.',
        parameters: z.object({ path: z.string().min(1) }),
        execute: async ({ path }) => {
          check();
          const folder = resolve(path);
          const home = homedir();
          if (!folder.toLowerCase().startsWith(home.toLowerCase()))
            throw new Error(`Only folders inside ${home} can be indexed.`);
          signal.throwIfAborted();
          return {
            folder,
            ...(await memory.indexFolder(folder)),
            totalChunks: memory.count(),
          };
        },
      }),
    );
  }
  return tools;
}
