import { createRegistryRelease, type NodeManifest } from '@pertexo/node-sdk';
import type {
  NodeAttemptLease,
  PublishedWorkflowV3Projection,
} from '@pertexo/database/execution';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
} from '@pertexo/workflow-engine';
import { workflowCallableContractIdentityV1 } from '@pertexo/workflow-model/workflow-call-closure';
import { describe, expect, it, vi } from 'vitest';
import { createNodeAttemptExecutionEngine } from '../src/execution/node-attempt-engine.js';
import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from './support/execution-engine.fixture.js';

// Local staged manifest: this test does not register native Call in a serving catalog.
const baseManifest = CORE_REGISTRY_RELEASE.definitions[0];
if (baseManifest === undefined) throw new Error('Missing base manifest');
const manifest: NodeManifest = {
  ...baseManifest,
  definition: { key: 'core.workflow_call', version: 1 },
  executor: { key: 'core.workflow_call', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', additionalProperties: true },
  inputSchema: { type: 'object', additionalProperties: true },
  outputSchema: { type: 'object', additionalProperties: true },
  ports: { inputs: ['in'], outputs: ['out'] },
  retryClass: 'unsafe',
  policyReferences: [
    { key: 'node.json.bounded', version: 1 },
    { key: 'workflow.call', version: 1 },
  ],
};
const release = composeExecutableCompatibilityReleaseV3(
  createRegistryRelease({
    epoch: CORE_REGISTRY_RELEASE.epoch,
    definitions: [...CORE_REGISTRY_RELEASE.definitions, manifest],
    executors: [
      ...CORE_REGISTRY_RELEASE.executors,
      {
        executor: manifest.executor,
        abiVersion: 1,
        definitions: [manifest.definition],
        lifecycle: 'active',
        policyReferences: manifest.policyReferences,
      },
    ],
    policies: [
      ...CORE_REGISTRY_RELEASE.policies,
      { key: 'workflow.call', version: 1 },
    ],
  }),
);
const callable = {
  schemaVersion: 1 as const,
  input: {
    type: 'object' as const,
    properties: { name: { type: 'string' as const } },
    required: ['name'],
  },
  result: { type: 'object' as const, properties: {}, required: [] },
  resultSelector: { kind: 'literal' as const, value: {} },
};
const child = buildWorkflowExecutableV3({
  release,
  graph: { ...graph(), schemaVersion: 2, callable },
});
const pin = {
  workflowId: WORKFLOW_ID,
  versionId: VERSION_ID,
  checksum: child.checksum,
  callableContractIdentity: workflowCallableContractIdentityV1(callable),
};
const base = graph();
const source = base.nodes[0];
const sink = base.nodes[1];
if (source === undefined || sink === undefined)
  throw new Error('Missing base nodes');
const parent = buildWorkflowExecutableV3({
  release,
  graph: {
    ...base,
    schemaVersion: 2,
    nodes: [
      source,
      {
        ...sink,
        id: 'call',
        definition: manifest.definition,
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
  },
});
function projection(value: typeof parent): PublishedWorkflowV3Projection {
  return {
    id: VERSION_ID,
    workspaceId: WORKSPACE_ID,
    workflowId: WORKFLOW_ID,
    schemaVersion: 2,
    versionNumber: 1,
    executableSchemaVersion: 3,
    executableJson: value.envelope,
    checksum: value.checksum,
    compatibilityReleaseEpoch: release.epoch,
  };
}
const lease: NodeAttemptLease = {
  workspaceId: WORKSPACE_ID,
  workflowVersionId: VERSION_ID,
  runId: RUN_ID,
  nodeRunId: '55555555-5555-4555-8555-555555555555',
  attemptId: '66666666-6666-4666-8666-666666666666',
  attemptNumber: 1,
  admissionKind: 'execute',
  invocationKey: `${VERSION_ID}|call|b:|i:`,
  nodeId: 'call',
  sideEffectClass: 'unsafe',
  workerId: 'worker',
  fenceToken: 1,
  leaseExpiresAt: new Date(),
  delivery: {
    outboxEventId: '77777777-7777-4777-8777-777777777777',
    payloadChecksum: 'a'.repeat(64),
  },
};
function attempt() {
  const prepared = createNodeAttemptExecutionEngine({
    admissionRelease: release,
  }).prepare({ lease, projection: projection(parent) });
  const execute = vi.fn().mockResolvedValue({
    kind: 'succeeded' as const,
    output: { name: 'input' },
  });
  const input = {
    runInput: {},
    completedNodeOutputs: [],
    abortRequested: false,
    registry: { execute },
    signal: new AbortController().signal,
  };
  return { prepared, execute, input };
}
describe('native Call retained descriptor', () => {
  it('verifies the exact pinned V3 artifact and supplies its callable descriptor', async () => {
    const { prepared, execute, input } = attempt();
    expect(prepared.callPin).toEqual(pin);
    expect(prepared.inputPersistence).toBe('workflow_call_declaration');
    await expect(
      prepared.execute({
        ...input,
        pinnedCallableProjection: projection(child),
      }),
    ).resolves.toMatchObject({ kind: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each([
    'absent',
    'workspace',
    'version',
    'workflow',
    'checksum',
    'body',
  ] as const)('rejects %s mismatch before dispatch', async (kind) => {
    const { prepared, execute, input } = attempt();
    const childProjection = projection(child);
    const other = '99999999-9999-4999-8999-999999999999';
    const candidate =
      kind === 'absent'
        ? undefined
        : kind === 'workspace'
          ? { ...childProjection, workspaceId: other }
          : kind === 'version'
            ? { ...childProjection, id: other }
            : kind === 'workflow'
              ? { ...childProjection, workflowId: other }
              : kind === 'checksum'
                ? {
                    ...childProjection,
                    checksum: `wf:v3:sha256:${'f'.repeat(64)}`,
                  }
                : { ...childProjection, executableJson: parent.envelope };
    await expect(
      prepared.execute({
        ...input,
        ...(candidate === undefined
          ? {}
          : { pinnedCallableProjection: candidate }),
      }),
    ).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
