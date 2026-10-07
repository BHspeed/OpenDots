import type { WebConfig } from './parallel.js';
import type { McpTools } from './mcp-tools.js';
import type { SetupStatus } from '../shared/types.js';
export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
  mcp?: McpTools;
  runTimeoutMs?: number;
  maxOutputTokens?: number;
}
// Local-only: a model identifier is the only requirement. Local servers such
// as Ollama accept any API key, so a placeholder is used when none is set.
// Slack channels require the CopilotKit cloud and are disabled here.
export function setupStatus(config: PlatformConfig): SetupStatus {
  const missing = [!config.model && 'OPENAI_MODEL'].filter(
    (item): item is string => !!item,
  );
  const slack = 'not_configured';
  return {
    intelligence: false,
    model: !!config.model,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    missing,
  };
}
