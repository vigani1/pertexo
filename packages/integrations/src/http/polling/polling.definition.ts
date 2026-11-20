import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import {
  HTTP_POLL_CONNECTION_SLOT,
  HTTP_POLL_TRIGGER,
  WORKFLOW_GRAPH_CONTRACT_LIMITS,
  httpPollConfigSchema,
} from '@pertexo/workflow-model';
import { z } from 'zod';
import { httpRequestConfigSchema } from '../request/request.schemas.js';

const configSchema = httpPollConfigSchema.extend({
  url: httpRequestConfigSchema
    .unwrap()
    .shape.url.meta(httpPollConfigSchema.shape.url.meta() ?? {}),
});

const pollEnvelope = z.strictObject({
  triggerId: z.uuid(),
  nodeId: z
    .string()
    .min(1)
    .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength),
  item: z.json(),
});

const manifest: NodeManifest = Object.freeze({
  definition: HTTP_POLL_TRIGGER,
  family: 'trigger',
  display: Object.freeze({
    name: 'HTTP Polling',
    description: 'Start a run for each new item in a JSON feed',
  }),
  configVersion: 1,
  configSchema: generateSchemaDocument(configSchema, {
    runtimeOnlySemantics: [
      'Items and item key paths must use the supported JSON path syntax.',
    ],
  }),
  inputSchema: generateSchemaDocument(pollEnvelope),
  outputSchema: generateSchemaDocument(pollEnvelope),
  ports: Object.freeze({
    inputs: Object.freeze([]),
    outputs: Object.freeze(['out']),
  }),
  credentialRequirements: Object.freeze([HTTP_POLL_CONNECTION_SLOT]),
  connectionRequirements: Object.freeze([HTTP_POLL_CONNECTION_SLOT]),
  optionalConnections: Object.freeze([HTTP_POLL_CONNECTION_SLOT]),
  retryClass: 'safe',
  resourceClass: 'cpu',
  capabilities: Object.freeze([]),
  executor: HTTP_POLL_TRIGGER,
  executorAbi: 1,
  policyReferences: Object.freeze([]),
});

export const HTTP_POLL_DEFINITION_REGISTRATION = Object.freeze({
  manifest,
  configSchema,
  inputSchema: pollEnvelope,
  outputSchema: pollEnvelope,
});
