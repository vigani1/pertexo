import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import type { WorkflowCallableDeclarationV1 } from '@pertexo/workflow-model/callable-graph-contract';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { workflowCallPinSchemaV1 } from '@pertexo/workflow-model/workflow-call-contract';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '../../src/executable-workflow.js';
import { invocationKey } from '../../src/transition/scheduling.js';
import {
  boundedPolicy,
  graph,
  nodeRelease,
} from '../executable-workflow.fixtures.js';

export const workflowVersionId = '00000000-0000-4000-8000-000000000001';
export const declarationAttemptId = '00000000-0000-4000-8000-000000000002';
export const childRunId = '00000000-0000-4000-8000-000000000003';
export const otherId = '00000000-0000-4000-8000-000000000004';
export const key = invocationKey({ workflowVersionId, nodeId: 'call' });
export const callPolicy = { key: 'workflow.call', version: 1 } as const;
const objectType = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
} as const;
export const declaration: WorkflowCallableDeclarationV1 = {
  schemaVersion: 1,
  input: objectType,
  result: objectType,
  resultSelector: { kind: 'run_input', path: '$' },
};
export const pin = workflowCallPinSchemaV1.parse({
  workflowId: otherId,
  versionId: otherId,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: workflowCallableContractIdentityV1(declaration),
});
// Local compatibility fixture: engine tests must not depend on nodes-core.
export const callManifest: NodeManifest = {
  schemaVersion: 1,
  definition: { key: 'core.workflow_call', version: 1 },
  family: 'logic',
  configVersion: 1,
  configSchema: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', format: 'uuid' },
      versionId: { type: 'string', format: 'uuid' },
      checksum: { type: 'string', pattern: '^wf:v3:sha256:[0-9a-f]{64}$' },
      callableContractIdentity: {
        type: 'string',
        pattern: '^callable:v1:sha256:[0-9a-f]{64}$',
      },
    },
    required: [
      'workflowId',
      'versionId',
      'checksum',
      'callableContractIdentity',
    ],
    additionalProperties: false,
  },
  inputSchema: { type: 'object', additionalProperties: true },
  outputSchema: { type: 'object', additionalProperties: true },
  ports: { inputs: ['in'], outputs: ['out'] },
  credentialRequirements: [],
  connectionRequirements: [],
  retryClass: 'unsafe',
  resourceClass: 'cpu',
  capabilities: [],
  lifecycle: 'active',
  executor: { key: 'core.workflow_call', version: 1 },
  executorAbi: 1,
  policyReferences: [boundedPolicy, callPolicy],
};
const baseRelease = nodeRelease();
export const release = composeExecutableCompatibilityReleaseV3(
  createRegistryRelease({
    epoch: 1,
    definitions: [...baseRelease.definitions, callManifest],
    executors: [
      ...baseRelease.executors,
      {
        executor: callManifest.executor,
        abiVersion: 1,
        definitions: [callManifest.definition],
        lifecycle: 'active',
        policyReferences: callManifest.policyReferences,
      },
    ],
    policies: [...baseRelease.policies, callPolicy],
  }),
);
export const callGraph = {
  schemaVersion: 2,
  settings: {},
  nodes: [
    graph().nodes[0],
    {
      ...graph().nodes[1],
      id: 'call',
      definition: callManifest.definition,
      config: pin,
      inputMappings: { name: { kind: 'literal', value: 'input' } },
    },
  ],
  edges: [
    {
      id: 'manual-call',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'call', port: 'in' },
    },
  ],
};
export const executable = buildWorkflowExecutableV3({
  release,
  graph: callGraph,
});
