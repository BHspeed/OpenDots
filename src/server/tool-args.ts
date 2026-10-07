import type { Message } from '@ag-ui/core';

/**
 * Returns the first complete JSON value in text, or undefined. Some local
 * models stream tool arguments twice ('{"a":1}{"a":1}'), which is not valid
 * JSON and makes the model server reject the whole conversation afterwards.
 */
export function firstJson(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Makes every assistant tool call carry valid JSON arguments. */
export function repairToolArguments(messages: Message[]): Message[] {
  return messages.map((message) => {
    const calls = (
      message as { toolCalls?: { function: { arguments: string } }[] }
    ).toolCalls;
    if (message.role !== 'assistant' || !calls?.length) return message;
    let changed = false;
    const toolCalls = calls.map((call) => {
      const raw = call.function.arguments ?? '';
      try {
        JSON.parse(raw || '{}');
        if (raw) return call;
      } catch {
        // fall through to repair
      }
      changed = true;
      return {
        ...call,
        function: { ...call.function, arguments: firstJson(raw) ?? '{}' },
      };
    });
    return changed ? ({ ...message, toolCalls } as Message) : message;
  });
}
