// Tool groups a Dot can be granted. Local MCP tools are mapped to groups by
// name; tools from any other MCP server form a group named after that server.
export const toolGroups = {
  files: {
    label: 'Files',
    description: 'List, search, read, write, copy, move and recycle files.',
    tools: [
      'list_directory',
      'find_files',
      'read_text_file',
      'write_text_file',
      'make_directory',
      'copy_path',
      'move_paths',
      'delete_to_recycle_bin',
    ],
  },
  vision: {
    label: 'Image reading',
    description: 'Describe images or the screen, read text in them.',
    tools: ['describe_image', 'take_screenshot'],
  },
  detection: {
    label: 'Object detection',
    description: 'Locate objects in images or the screen with YOLO.',
    tools: ['detect_objects', 'take_screenshot'],
  },
  pc_control: {
    label: 'PC control',
    description:
      'Windows, mouse, keyboard and opening apps (asks before acting).',
    tools: [
      'list_windows',
      'focus_window',
      'mouse_click',
      'type_text',
      'press_keys',
      'scroll',
      'open_path',
      'open_url',
      'launch_app',
      'list_apps',
      'take_screenshot',
      'system_info',
    ],
  },
  browser: {
    label: 'Web browser',
    description:
      'Its own Chrome window: open sites, read, click, type, fill forms (asks before submitting).',
    tools: [
      'browser_open',
      'browser_snapshot',
      'browser_read',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_scroll',
      'browser_back',
      'browser_tabs',
      'browser_switch_tab',
      'browser_screenshot',
      'browser_close',
    ],
  },
  web: {
    label: 'Web search',
    description: 'Search DuckDuckGo and read public pages (queries leave PC).',
    tools: ['web_search', 'fetch_page'],
  },
  memory: {
    label: 'Long-term memory',
    description: 'Search past conversations and indexed folders.',
    tools: ['search_memory', 'index_folder'],
  },
  delegation: {
    label: 'Delegate to Dots',
    description: 'Hand tasks to other specialist Dots and use their answers.',
    tools: ['list_specialists', 'delegate_task'],
  },
} as const;
export type ToolGroup = keyof typeof toolGroups;
export const allToolGroups = Object.keys(toolGroups) as ToolGroup[];
/** Groups granted to Dots created before per-Dot permissions existed. */
export const legacyToolGroups: string[] = [
  'files',
  'vision',
  'detection',
  'pc_control',
  'memory',
];
export const defaultToolGroups: string[] = ['memory'];
export const localServer = 'localtools';
/** Group for a tool from an MCP server; null when not grantable. */
export function groupsForTool(server: string, tool: string): string[] {
  if (server !== localServer) return [`mcp:${server}`];
  return allToolGroups.filter((group) =>
    (toolGroups[group].tools as readonly string[]).includes(tool),
  );
}
export function allowsTool(granted: string[], server: string, tool: string) {
  return groupsForTool(server, tool).some((group) => granted.includes(group));
}
