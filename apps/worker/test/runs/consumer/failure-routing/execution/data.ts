import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { initialCheckpointFactory } from '@pertexo/core/execution';

import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';

import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';
import { insertCompiledWorkflow } from '../../../../support/coordinator/workflows.js';
import { graph } from '../fixture.js';
import type { RoutingScenario } from './contract.js';

export async function assertDataFailureRoutes(scenario: RoutingScenario) {
  const { control, runs, catalog, executed } = scenario;
  // Actual data executors must use the same durable route owner as providers.
  control.mode = 'normal';
  const dataFailures: readonly Readonly<{
    key: string;
    config: WorkflowNode['config'];
    input: WorkflowNode['config'];
    code: string;
  }>[] = [
    {
      key: 'core.xml',
      config: { operation: 'parse' },
      input: { value: '<root><broken></root>' },
      code: 'utility.xml_malformed',
    },
    {
      key: 'core.create_file',
      config: { format: 'csv', delimiter: ',', columns: [] },
      input: { data: [1] },
      code: 'file.create_data',
    },
  ];
  for (const example of dataFailures) {
    const dataWorkflowId = randomUUID(),
      dataVersionId = randomUUID();
    const dataGraph: WorkflowGraph = {
      ...graph(),
      nodes: graph().nodes.map((node) =>
        node.id !== 'source'
          ? node
          : {
              ...node,
              definition: { key: example.key, version: 1 },
              config: example.config,
              inputMappings: Object.fromEntries(
                Object.entries(example.input).map(([name, value]) => [
                  name,
                  { kind: 'literal' as const, value },
                ]),
              ),
            },
      ),
    };
    await insertCompiledWorkflow(fixture.ownerQuery, {
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      identity: {
        workflowId: dataWorkflowId,
        workflowVersionId: dataVersionId,
      },
      graph: dataGraph,
      name: `Handled ${example.key} input failure`,
      catalog: PLATFORM_NODE_CATALOG,
    });
    await fixture.ownerQuery(
      'update app.workflows set published_version_id=$2 where id=$1',
      [dataWorkflowId, dataVersionId],
    );
    const requestKey = createHash('sha256').update(randomUUID()).digest('hex');
    const started = await runs.start({
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      workflowId: dataWorkflowId,
      idempotencyKeyHash: requestKey,
      requestHash: requestKey,
      scope: `workflow:${dataWorkflowId}:manual`,
      input: {},
      checkpointFactory: initialCheckpointFactory({ catalog }),
    });
    await fixture.waitFor(
      () =>
        fixture.workerQuery<{ status: string }>(
          `select status, (select jsonb_agg(jsonb_build_object('node',node_id,'status',status,'code',safe_error_code)) from app.node_runs where workflow_run_id=$1) nodes from app.workflow_runs where id=$1`,
          [started.run.id],
        ),
      (rows) => rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed',
    );
    const handled = await runs.get({
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      runId: started.run.id,
    });
    expect.soft(handled?.run.status, example.code).toBe('succeeded');
    expect.soft(handled?.run.handledFailureCount).toBe(1);
    expect
      .soft(handled?.nodes.find((node) => node.nodeId === 'source'))
      .toMatchObject({
        status: 'failed',
        failureHandling: { disposition: 'handled' },
        safeErrorCode: example.code,
      });
    expect
      .soft(
        handled?.nodes.find((node) => node.nodeId === 'normal-stop')?.status,
      )
      .toBe('skipped');
    expect
      .soft(
        executed.find(
          (node) => node.runId === started.run.id && node.nodeId === 'handler',
        )?.input,
      )
      .toMatchObject({
        failure: {
          errorKind: 'configuration',
          safeErrorCode: example.code,
        },
      });
  }
}
