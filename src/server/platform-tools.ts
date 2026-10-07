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
  if (granted.includes('developer') && config.dev) {
    const dev = config.dev;
    const guard = async <T>(work: () => T | Promise<T>): Promise<T> => {
      check();
      return work();
    };
    tools.push(
      defineTool({
        name: 'dev_start',
        description:
          "Start a code change: creates a fresh branch and separate working copy of OpenDots' code. Nothing touches the running app.",
        parameters: z.object({ title: z.string().min(3).max(80) }),
        execute: ({ title }) => guard(() => dev.start(title)),
      }),
      defineTool({
        name: 'dev_overview',
        description:
          'List the source files of OpenDots with their sizes, to find where to work.',
        parameters: z.object({}),
        execute: () => guard(() => ({ files: dev.overview() })),
      }),
      defineTool({
        name: 'dev_list',
        description: 'List a folder in the working copy, e.g. "src/client".',
        parameters: z.object({ dir: z.string().max(200).optional() }),
        execute: ({ dir }) => guard(() => ({ entries: dev.list(dir || '.') })),
      }),
      defineTool({
        name: 'dev_read',
        description:
          'Read a source file with line numbers (optionally a line range).',
        parameters: z.object({
          path: z.string().min(1).max(300),
          start: z.number().int().optional(),
          end: z.number().int().optional(),
        }),
        execute: ({ path, start, end }) =>
          guard(() => dev.read(path, start || 1, end || 0)),
      }),
      defineTool({
        name: 'dev_search',
        description:
          'Search the code (src and tests) for text; returns file:line matches.',
        parameters: z.object({ text: z.string().min(2).max(200) }),
        execute: ({ text }) => guard(() => dev.search(text)),
      }),
      defineTool({
        name: 'dev_edit',
        description:
          'Change code by replacing an exact block of text (copy it from dev_read without the line numbers) with new text. The block must appear exactly once.',
        parameters: z.object({
          path: z.string().min(1).max(300),
          find: z.string().min(1),
          replace: z.string(),
        }),
        execute: ({ path, find, replace }) =>
          guard(() => dev.edit(path, find, replace)),
      }),
      defineTool({
        name: 'dev_write',
        description:
          'Create a new file, or replace a whole file, in the working copy.',
        parameters: z.object({
          path: z.string().min(1).max(300),
          content: z.string(),
        }),
        execute: ({ path, content }) => guard(() => dev.write(path, content)),
      }),
      defineTool({
        name: 'dev_checks',
        description:
          'Run the type-check, lint and full test suite on the working copy. Returns PASS/FAIL per step with the failure output.',
        parameters: z.object({}),
        execute: () => guard(() => dev.checks()),
      }),
      defineTool({
        name: 'dev_diff',
        description: 'Show the current changes (diff) in the working copy.',
        parameters: z.object({}),
        execute: async () => ({
          diff: (await guard(() => dev.diff())).slice(0, 20000),
        }),
      }),
      defineTool({
        name: 'dev_submit',
        description:
          'Finish: runs the checks, commits the branch and sends it to the owner for review. The owner applies or rejects it; tell them it is waiting in the Changes tab of the side panel.',
        parameters: z.object({
          title: z.string().min(3).max(120),
          summary: z.string().min(10).max(2000),
        }),
        execute: async ({ title, summary }) => {
          const review = await guard(() => dev.submit(title, summary));
          return {
            submitted: review.title,
            checks_passed: review.passed,
            next: 'Waiting for the owner to review it in the Changes tab.',
          };
        },
      }),
      defineTool({
        name: 'dev_discard',
        description:
          'Throw away the change in progress (deletes its branch and working copy).',
        parameters: z.object({}),
        execute: async () => {
          await guard(() => dev.discard());
          return { discarded: true };
        },
      }),
    );
  }
  return tools;
}
