import { createHash, randomUUID } from 'node:crypto';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { createInitialCheckpoint } from '@pertexo/core/execution';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  WORKFLOW_GRAPH_LIMITS,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowCallPin,
} from '@pertexo/workflow-model';
import { acceptManualFixtureRun } from '../../support/attempts/manual-start.js';
import { insertCompiledWorkflow } from '../../support/coordinator/workflows.js';
import { fixture, node, edge } from '../calls/fixtures.js';

function loop(
  id: string,
  iterations: number,
  concurrency: number,
  body: WorkflowNode,
): WorkflowNode {
  return {
    ...node(id, 'core.foreach'),
    inputMappings: {
      items: {
        kind: 'literal',
        value: Array.from({ length: iterations }, (_, i) => i),
      },
    },
    structured: {
      kind: 'for_each',
      maxIterations: iterations,
      maxConcurrency: concurrency,
      body: {
        settings: {},
        nodes: [body],
        edges: [],
        inputPorts: ['item', 'ordinal'],
        outputPorts: ['result'],
      },
    },
  };
}
export function maximumLoop(
  kind: 'parallel' | 'nested' | 'call',
  target: WorkflowCallPin,
): WorkflowGraph {
  const cap = WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations;
  const body =
    kind === 'call'
      ? {
          ...node('call', 'core.call'),
          config: { target: { ...target } },
          inputMappings: { input: { kind: 'literal' as const, value: {} } },
        }
      : node('body', 'core.set');
  const owner =
    kind === 'nested'
      ? loop('outer', 2, 2, loop('inner', Math.floor((cap - 4) / 2), 98, body))
      : loop(
          'loop',
          kind === 'call'
            ? Math.floor((cap - 2) / 2)
            : WORKFLOW_GRAPH_LIMITS.maxLoopIterations,
          198,
          body,
        );
  return {
    settings: {},
    nodes: [node('manual', 'core.manual'), owner],
    edges: [edge('manual', owner.id)],
  };
}
export const callable: WorkflowGraph = {
  settings: {},
  nodes: [node('manual', 'core.manual')],
  edges: [],
  callable: {
    input: { type: 'object', properties: [] },
    resultType: { type: 'object', properties: [] },
    result: { kind: 'run_input', path: '$' },
  },
};

/** A second real workspace competes through the same dispatcher and workers. */
export async function acceptQuietWorkspace() {
  const workspaceId = randomUUID();
  const query = async (text: string, values: readonly unknown[] = []) => {
    const client = await fixture.ownerPool.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const result = await client.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      await client.query('commit');
      return result.rows;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };
  await query(
    "insert into app.workspaces(id,name,slug,status,created_by) values($1,'Quiet loop witness',$2,'active',$3)",
    [workspaceId, `quiet-${workspaceId}`, fixture.actorId],
  );
  await query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
    [workspaceId, fixture.actorId],
  );
  const identity = {
    workflowId: randomUUID(),
    workflowVersionId: randomUUID(),
  };
  const executable = await insertCompiledWorkflow(query, {
    actorId: fixture.actorId,
    workspaceId,
    identity,
    graph: { settings: {}, nodes: [node('manual', 'core.manual')], edges: [] },
    name: 'Quiet fairness witness',
    catalog: PLATFORM_NODE_CATALOG,
  });
  const initial = createInitialCheckpoint(
    {
      id: identity.workflowVersionId,
      workspaceId,
      workflowId: identity.workflowId,
      versionNumber: 1,
      checksum: executable.checksum,
      executableJson: executable.envelope,
    },
    { catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG) },
  );
  const accepted = await fixture.apiDatabase.withWorkspace(
    workspaceId,
    (transaction) =>
      acceptManualFixtureRun(transaction, {
        initialCheckpoint: initial.checkpoint,
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        requestHash: createHash('sha256').update('{}').digest('hex'),
        operation: 'workflow.run.accept',
        scope: `workflow:${identity.workflowId}:manual`,
        triggerType: 'manual',
        ...identity,
        runInput: {},
      }),
  );
  return { workspaceId, runId: accepted.runId };
}
