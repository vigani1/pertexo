import { readFile } from 'node:fs/promises';

import {
  PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
  PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
} from '@pertexo/node-catalog';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';

type Query = (
  statement: string,
  parameters?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

interface WorkflowIdentity {
  readonly workflowId: string;
  readonly workflowVersionId: string;
}

export interface CoordinatorWorkflowFixtureIdentities {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly retained: WorkflowIdentity;
  readonly condition: WorkflowIdentity;
  readonly forEach: WorkflowIdentity;
  readonly parallel: WorkflowIdentity;
  readonly switch: WorkflowIdentity;
}

const manualNode = {
  id: 'manual',
  definition: { key: 'core.manual', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
} as const;

function setNode(id: string, y: number, value = id) {
  return {
    id,
    definition: { key: 'core.set', version: 1 },
    position: { x: 20, y },
    configVersion: 1,
    config: {},
    inputMappings: {
      value: { kind: 'literal' as const, value },
    },
    connectionRefs: {},
  };
}

function branchGraph(kind: 'condition' | 'switch') {
  const control =
    kind === 'condition'
      ? {
          id: 'condition',
          definition: { key: 'core.condition', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {
            condition: { kind: 'literal' as const, value: true },
          },
          connectionRefs: {},
        }
      : {
          id: 'switch',
          definition: { key: 'core.switch', version: 1 },
          position: { x: 10, y: 0 },
          configVersion: 1,
          config: { cases: [{ id: 'case-01', equals: 'selected' }] },
          inputMappings: {
            value: { kind: 'literal' as const, value: 'selected' },
          },
          connectionRefs: {},
        };
  const controlId = control.id;
  return {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      control,
      setNode('selected', -10),
      setNode('unselected', 10),
    ],
    edges: [
      {
        id: `manual-${controlId}`,
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: controlId, port: 'in' },
      },
      {
        id: `${controlId}-selected`,
        source: {
          nodeId: controlId,
          port: kind === 'condition' ? 'true' : 'case-01',
        },
        target: { nodeId: 'selected', port: 'in' },
      },
      {
        id: `${controlId}-unselected`,
        source: {
          nodeId: controlId,
          port: kind === 'condition' ? 'false' : 'default',
        },
        target: { nodeId: 'unselected', port: 'in' },
      },
    ],
  };
}

function forEachGraph() {
  return {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      {
        id: 'for-each',
        definition: { key: 'core.foreach', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          items: {
            kind: 'literal' as const,
            value: [
              { id: 'alpha', value: 11 },
              { id: 'beta', value: 22 },
              { id: 'gamma', value: 33 },
            ],
          },
        },
        connectionRefs: {},
        structured: {
          kind: 'for_each' as const,
          maxIterations: 3,
          maxConcurrency: 2,
          body: {
            schemaVersion: 1 as const,
            settings: {},
            inputPorts: ['item', 'ordinal'],
            outputPorts: ['result'],
            nodes: [
              {
                ...setNode('body-map', 0),
                position: { x: 0, y: 0 },
                inputMappings: {
                  item: {
                    kind: 'structured_input' as const,
                    port: 'item' as const,
                    path: '$',
                  },
                  ordinal: {
                    kind: 'structured_input' as const,
                    port: 'ordinal' as const,
                    path: '$',
                  },
                },
              },
              {
                ...setNode('body-sink', 0),
                position: { x: 10, y: 0 },
                inputMappings: {
                  result: {
                    kind: 'node_output' as const,
                    nodeId: 'body-map',
                    path: '$',
                  },
                },
              },
            ],
            edges: [
              {
                id: 'body-map-sink',
                source: { nodeId: 'body-map', port: 'out' },
                target: { nodeId: 'body-sink', port: 'in' },
              },
            ],
          },
        },
      },
      {
        id: 'outer-successor',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 20, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'for-each',
            path: '$',
          },
        },
        connectionRefs: {},
      },
    ],
    edges: [
      {
        id: 'manual-for-each',
        source: { nodeId: 'manual', port: 'out' },
        target: { nodeId: 'for-each', port: 'in' },
      },
      {
        id: 'for-each-outer',
        source: { nodeId: 'for-each', port: 'out' },
        target: { nodeId: 'outer-successor', port: 'in' },
      },
    ],
  };
}

function parallelGraph() {
  return {
    schemaVersion: 1 as const,
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      manualNode,
      {
        id: 'parallel',
        definition: { key: 'core.parallel', version: 1 },
        position: { x: 10, y: 0 },
        configVersion: 1,
        config: {
          branches: [{ id: 'branch-02' }, { id: 'branch-01' }],
          maxConcurrency: 1,
        },
        inputMappings: {},
        connectionRefs: {},
      },
      setNode('left', -10),
      setNode('right', 10),
      {
        id: 'merge',
        definition: { key: 'core.merge', version: 1 },
        position: { x: 30, y: 0 },
        configVersion: 1,
        config: {
          parallelNodeId: 'parallel',
          policy: { kind: 'all' as const },
        },
        inputMappings: {},
        connectionRefs: {},
      },
      {
        id: 'terminate',
        definition: { key: 'core.terminate', version: 1 },
        position: { x: 40, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [
      ['manual-parallel', 'manual', 'out', 'parallel', 'in'],
      ['parallel-left', 'parallel', 'branch-01', 'left', 'in'],
      ['parallel-right', 'parallel', 'branch-02', 'right', 'in'],
      ['left-merge', 'left', 'out', 'merge', 'branch-01'],
      ['right-merge', 'right', 'out', 'merge', 'branch-02'],
      ['merge-terminate', 'merge', 'out', 'terminate', 'in'],
    ].map(([id, sourceNodeId, sourcePort, targetNodeId, targetPort]) => ({
      id,
      source: { nodeId: sourceNodeId, port: sourcePort },
      target: { nodeId: targetNodeId, port: targetPort },
    })),
  };
}

async function insertCompiledWorkflow(
  query: Query,
  input: Readonly<{
    actorId: string;
    graph: unknown;
    identity: WorkflowIdentity;
    name: string;
    release: Parameters<typeof composeExecutableCompatibilityRelease>[0];
    workspaceId: string;
  }>,
): Promise<void> {
  const executable = buildWorkflowExecutableV2({
    graph: input.graph,
    release: composeExecutableCompatibilityRelease(input.release),
  });
  await query(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, $3, $4)`,
    [input.identity.workflowId, input.workspaceId, input.name, input.actorId],
  );
  await query(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      input.identity.workflowVersionId,
      input.workspaceId,
      input.identity.workflowId,
      JSON.stringify(input.graph),
      executable.checksum,
      JSON.stringify(executable.envelope),
      executable.envelope.compatibilityReleaseEpoch,
      input.actorId,
    ],
  );
}

export async function seedCoordinatorWorkflowFixtures(
  query: Query,
  identities: CoordinatorWorkflowFixtureIdentities,
): Promise<void> {
  const retained = JSON.parse(
    await readFile(
      new URL('../fixtures/retained-core-workflow-v2.json', import.meta.url),
      'utf8',
    ),
  ) as {
    checksum: string;
    executable: { compatibilityReleaseEpoch: number };
    graph: unknown;
  };
  await query(
    `insert into app.users (id, email, display_name, status)
       values ($1, $2, 'Coordinator proof', 'active')`,
    [identities.actorId, `coordinator-${identities.actorId}@example.test`],
  );
  await query(
    `insert into app.workspaces (id, name, slug, status, created_by)
       values ($1, 'Coordinator proof', $2, 'active', $3)`,
    [
      identities.workspaceId,
      `coordinator-${identities.workspaceId}`,
      identities.actorId,
    ],
  );
  await query(
    `insert into app.workflows (id, workspace_id, name, created_by)
       values ($1, $2, 'Coordinator proof', $3)`,
    [
      identities.retained.workflowId,
      identities.workspaceId,
      identities.actorId,
    ],
  );
  await query(
    `insert into app.workflow_versions (
       id, workspace_id, workflow_id, version_number, schema_version,
       graph_json, checksum, executable_schema_version, executable_json,
       compatibility_release_epoch, published_by
     ) values ($1, $2, $3, 1, 1, $4::jsonb, $5, 2, $6::jsonb, $7, $8)`,
    [
      identities.retained.workflowVersionId,
      identities.workspaceId,
      identities.retained.workflowId,
      JSON.stringify(retained.graph),
      retained.checksum,
      JSON.stringify(retained.executable),
      retained.executable.compatibilityReleaseEpoch,
      identities.actorId,
    ],
  );
  await Promise.all([
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: forEachGraph(),
      identity: identities.forEach,
      name: 'For Each recovery proof',
      release: PLATFORM_REGISTRY_RELEASE_FOR_EACH_ACTIVE,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: parallelGraph(),
      identity: identities.parallel,
      name: 'Parallel Merge recovery proof',
      release: PLATFORM_REGISTRY_RELEASE_MERGE_ACTIVE,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: branchGraph('switch'),
      identity: identities.switch,
      name: 'Switch recovery proof',
      release: PLATFORM_REGISTRY_RELEASE_SWITCH_ACTIVE,
      workspaceId: identities.workspaceId,
    }),
    insertCompiledWorkflow(query, {
      actorId: identities.actorId,
      graph: branchGraph('condition'),
      identity: identities.condition,
      name: 'Condition recovery proof',
      release: PLATFORM_REGISTRY_RELEASE_CONDITION_ACTIVE,
      workspaceId: identities.workspaceId,
    }),
  ]);
}
