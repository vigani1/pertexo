import { generateSchemaDocument, type NodeManifest } from '@pertexo/node-sdk';
import type {
  AssistantDisclosure,
  NodeDefinitionRegistration,
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';

const pollEnvelope = z.strictObject({
  triggerId: z.uuid(),
  nodeId: z
    .string()
    .min(1)
    .max(WORKFLOW_GRAPH_CONTRACT_LIMITS.identifierLength),
  item: z.json(),
});

export function registerPollingDefinition<Config extends z.ZodType>({
  definition,
  display,
  configSchema,
  assistantDisclosure,
  connectionSlot,
  optionalConnection,
  runtimeOnlySemantics,
}: Readonly<{
  definition: NodeManifest['definition'];
  display: NodeManifest['display'];
  configSchema: Config;
  // Every poll shares one input envelope, so a trigger declares only its config.
  assistantDisclosure: Pick<AssistantDisclosure, 'config'>;
  connectionSlot: string;
  optionalConnection?: boolean;
  runtimeOnlySemantics?: readonly [string, ...string[]];
}>): NodeDefinitionRegistration & {
  readonly configSchema: Config;
  readonly inputSchema: typeof pollEnvelope;
  readonly outputSchema: typeof pollEnvelope;
} {
  const manifest: NodeManifest = Object.freeze({
    definition,
    family: 'trigger',
    display: Object.freeze(display),
    configVersion: 1,
    configSchema: generateSchemaDocument(
      configSchema,
      runtimeOnlySemantics === undefined
        ? undefined
        : {
            runtimeOnlySemantics: runtimeOnlySemantics,
          },
    ),
    inputSchema: generateSchemaDocument(pollEnvelope),
    outputSchema: generateSchemaDocument(pollEnvelope),
    ports: Object.freeze({
      inputs: Object.freeze([]),
      outputs: Object.freeze(['out']),
    }),
    credentialRequirements: Object.freeze([connectionSlot]),
    connectionRequirements: Object.freeze([connectionSlot]),
    ...(optionalConnection
      ? { optionalConnections: Object.freeze([connectionSlot]) }
      : {}),
    retryClass: 'safe',
    resourceClass: 'cpu',
    capabilities: Object.freeze([]),
    executor: definition,
    executorAbi: 1,
    policyReferences: Object.freeze([]),
  });
  return Object.freeze({
    manifest,
    configSchema,
    assistantDisclosure: {
      ...assistantDisclosure,
      inputs: { visible: ['triggerId', 'nodeId', 'item'], masked: [] },
    },
    inputSchema: pollEnvelope,
    outputSchema: pollEnvelope,
  });
}

export function createPollingExecutor(
  executor: NodeManifest['definition'],
): NodeExecutorRegistration {
  return Object.freeze({
    executor,
    execute: (invocation: NodeExecutionInvocation<unknown, unknown>) =>
      Promise.resolve(invocation.input),
  });
}
