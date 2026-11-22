import type { IntegrationModule } from '../providers/integration-module.js';
import { CALL_TOOL_REGISTRATION } from './call-tool/call-tool.definition.js';
import { MCP_FAILURE_CODES } from './call-tool/call-tool.errors.js';
import { createCallToolExecutor } from './call-tool/call-tool.executor.js';
import { MCP_CONNECTION, MCP_PROVIDER_KEY } from './connections.definition.js';
import { toolsLookup } from './tools-lookup.js';

export const MCP_MODULE = {
  key: MCP_PROVIDER_KEY,
  presentation: { name: 'MCP', icon: 'plug', group: 'action' },
  connections: [MCP_CONNECTION],
  lookups: [toolsLookup],
  executorSummaryCodes: MCP_FAILURE_CODES,
  steps: [
    {
      registration: CALL_TOOL_REGISTRATION,
      createExecutor: ({ httpClient }) => createCallToolExecutor(httpClient),
    },
  ],
} satisfies IntegrationModule;
