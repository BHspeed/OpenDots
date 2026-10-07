import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import { firstJson, repairToolArguments } from '../src/server/tool-args.js';

it('repairs doubled or broken tool-call arguments and leaves valid ones alone', () => {
  expect(firstJson('{"a":1}{"a":1}')).toBe('{"a":1}');
  expect(firstJson('{"q":"a } b"}{"q":"a } b"}')).toBe('{"q":"a } b"}');
  expect(firstJson('{}{}')).toBe('{}');
  expect(firstJson('not json')).toBeUndefined();
  const call = (id: string, args: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'tool', arguments: args },
  });
  const messages = [
    { id: 'u', role: 'user', content: 'hi' },
    {
      id: 'a',
      role: 'assistant',
      toolCalls: [
        call('1', '{"x":1}{"x":1}'),
        call('2', '{"ok":true}'),
        call('3', ''),
        call('4', 'garbage'),
      ],
    },
  ] as Message[];
  const [user, assistant] = repairToolArguments(messages) as [
    Message,
    { toolCalls: { function: { arguments: string } }[] },
  ];
  expect(user).toBe(messages[0]);
  expect(assistant.toolCalls.map((c) => c.function.arguments)).toEqual([
    '{"x":1}',
    '{"ok":true}',
    '{}',
    '{}',
  ]);
});
