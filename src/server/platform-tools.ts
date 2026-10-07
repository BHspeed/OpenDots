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
  if (granted.includes('self_improve') && config.skills) {
    const skills = config.skills;
    tools.push(
      defineTool({
        name: 'save_skill',
        description:
          'Save a procedure that worked so you (or every Dot, if shared) do it right next time. Use after finishing a multi-step task, or when the owner corrects you. Saving the same name updates it. Write concrete, reusable steps (which tools, in what order, what to watch for), not a story of this conversation.',
        parameters: z.object({
          name: z
            .string()
            .min(3)
            .max(80)
            .describe('Short title, e.g. "Search Wikipedia"'),
          when_to_use: z.string().min(5).max(500),
          steps: z.string().min(10).max(4000),
          shared: z
            .boolean()
            .optional()
            .describe('true to share with all Dots (general know-how)'),
        }),
        execute: async ({ name, when_to_use, steps, shared }) => {
          check();
          const skill = await skills.save({
            dotId: shared ? null : dot.id,
            name,
            whenToUse: when_to_use,
            steps,
          });
          return { saved: skill.name, shared: skill.dotId === null };
        },
      }),
      defineTool({
        name: 'list_skills',
        description:
          'List the skills you have learned (names and when to use them).',
        parameters: z.object({}),
        execute: async () => ({
          skills: skills.list(dot.id).map((skill) => ({
            name: skill.name,
            when_to_use: skill.whenToUse,
            shared: skill.dotId === null,
          })),
        }),
      }),
      defineTool({
        name: 'read_skill',
        description: 'Read the full steps of a learned skill by name.',
        parameters: z.object({ name: z.string().min(1).max(80) }),
        execute: async ({ name }) => {
          const skill = skills.get(dot.id, name);
          if (!skill)
            throw new Error(`No skill named "${name}". Use list_skills.`);
          return {
            name: skill.name,
            when_to_use: skill.whenToUse,
            steps: skill.steps,
          };
        },
      }),
      defineTool({
        name: 'propose_instruction_change',
        description:
          'Propose new role instructions for yourself when your current ones keep leading you wrong. The owner must approve it in your settings; nothing changes until then. Provide the complete new instructions and why.',
        parameters: z.object({
          new_instructions: z.string().min(20).max(2000),
          reason: z.string().min(10).max(1000),
        }),
        execute: async ({ new_instructions, reason }) => {
          check();
          skills.propose(dot.id, new_instructions, reason);
          return {
            status:
              'Proposal saved. Tell the owner it is waiting for their approval in your Dot settings.',
          };
        },
      }),
    );
  }
  return tools;
}
