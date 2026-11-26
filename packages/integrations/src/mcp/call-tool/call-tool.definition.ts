import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import { DISPATCH_AWARE_EXECUTOR_ABI_VERSION } from '@pertexo/node-sdk/server';
import { MCP_AUTH_TYPE, MCP_PROVIDER_KEY } from '../connections.definition.js';
import {
  callToolConfigSchema,
  callToolInputSchema,
  callToolOutputSchema,
} from './call-tool.schemas.js';

export const MCP_CALL_TOOL_STEP = Object.freeze({
  key: 'mcp.call_tool',
  version: 1,
});

const manifest: NodeManifest = Object.freeze({
  definition: MCP_CALL_TOOL_STEP,
  family: 'action',
  display: {
    name: 'MCP Call Tool',
    description: 'Call a tool on a connected MCP server',
    sideEffect:
      'This sends the mapped arguments to the MCP server. The tool may change remote data.',
  },
  configVersion: 1,
  configSchema: generateSchemaDocument(callToolConfigSchema, {
    runtimeOnlySemantics: [
      'The selected tool input schema must use the supported bounded JSON Schema subset.',
    ],
  }),
  inputSchema: generateSchemaDocument(callToolInputSchema),
  outputSchema: generateSchemaDocument(callToolOutputSchema),
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [MCP_AUTH_TYPE],
  connectionRequirements: [MCP_AUTH_TYPE],
  integration: { providerKey: MCP_PROVIDER_KEY, operationKey: 'call_tool' },
  retryClass: 'unsafe',
  resourceClass: 'io',
  capabilities: ['external_http', 'side_effect_disclosure'],
  executor: MCP_CALL_TOOL_STEP,
  executorAbi: DISPATCH_AWARE_EXECUTOR_ABI_VERSION,
  policyReferences: [],
});

export const CALL_TOOL_REGISTRATION = Object.freeze({
  manifest,
  assistantDisclosure: {
    config: { visible: ['toolName', 'toolInputSchema'] },
    inputs: { visible: [], unlisted: 'masked' },
  } as const,
  configSchema: callToolConfigSchema,
  inputSchema: callToolInputSchema,
  outputSchema: callToolOutputSchema,
});
