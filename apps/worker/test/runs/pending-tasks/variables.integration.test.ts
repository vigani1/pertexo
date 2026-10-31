import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  inputRequestConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  createPendingTaskStore,
  createWorkflowRunDatabase,
} from '@pertexo/database/runs';
import { createWorkspaceVariablesStore } from '@pertexo/core/variables';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { initialCheckpointFactory } from '@pertexo/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  fixture,
  node,
  edge,
  publishGraph,
  accept,
  runtime,
  parentGraph,
} from '../calls/fixtures.js';
const graph = (): WorkflowGraph => ({
  settings: { maxRunDurationMs: 60000 },
  callable: {
    input: { type: 'object', properties: [] },
    resultType: { type: 'number' },
    result: {
      kind: 'expression',
      language: 'jsonata',
      expression: '$vars.RATE',
    },
  },
  nodes: [
    node('manual', 'core.manual'),
    {
      ...node('input', 'core.request_input'),
      config: inputRequestConfigSchema.parse({}),
    },
    {
      ...node('finish', 'core.terminate'),
      inputMappings: { result: { kind: 'workspace_variable', name: 'RATE' } },
    },
  ],
  edges: [edge('manual', 'input'), edge('input', 'finish')],
});
describe.runIf(fixture.enabled)(
  'immutable variable snapshots through live workers',
  () => {
    beforeAll(fixture.setup, 60000);
    afterAll(fixture.restoreServicesAndClose);
    const config = () =>
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
        max: 3,
      });
    it('keeps values through a task restart, nested Calls and replay; a new run picks up edits', async () => {
      const variables = createWorkspaceVariablesStore(config()),
        tasks = createPendingTaskStore(config()),
        runs = createWorkflowRunDatabase(config()),
        workers = await runtime();
      const scope = {
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
      };
      try {
        await variables.replace({
          ...scope,
          expectedRevision: 0,
          values: { RATE: 10 },
          idempotencyKey: randomUUID(),
        });
        const leaf = await publishGraph(graph());
        // A callable result is resolved separately from a mapped step: both must use the captured map.
        const middleGraph = parentGraph(leaf.pin);
        if (middleGraph.callable === undefined)
          throw new Error('Callable missing');
        const middle = await publishGraph({
          ...middleGraph,
          callable: {
            ...middleGraph.callable,
            input: { type: 'object', properties: [] },
            resultType: { type: 'number' },
          },
        });
        const rootGraph = parentGraph(middle.pin);
        if (rootGraph.callable === undefined)
          throw new Error('Callable missing');
        const root = await publishGraph({
          ...rootGraph,
          callable: {
            ...rootGraph.callable,
            input: { type: 'object', properties: [] },
            resultType: { type: 'number' },
          },
        });
        await fixture.ownerQuery(
          'update app.workflows set published_version_id=$2 where id=$1',
          [root.workflowId, root.workflowVersionId],
        );
        const source = await accept(root, {});
        async function finish(runId: string, expected: number) {
          let taskId = '';
          await workers.until(async () => {
            const rows = await fixture.workerQuery<{ id: string }>(
              "select task.id from app.pending_run_tasks task join app.workflow_runs leaf on leaf.id=task.run_id where task.status='pending' and (leaf.id in (with recursive family(id) as (select $1::uuid union all select call.child_run_id from app.workflow_calls call join family on call.parent_run_id=family.id where call.child_run_id is not null) select id from family))",
              [runId],
            );
            expect(rows).toHaveLength(1);
            taskId = rows[0]?.id ?? '';
          });
          await workers.restart();
          await tasks.submit({
            ...scope,
            taskId,
            values: { message: 'Continue' },
            idempotencyKey: randomUUID(),
          });
          await workers.until(async () => {
            expect(
              await fixture.workerQuery(
                'select status,output_ref from app.workflow_runs where id=$1',
                [runId],
              ),
            ).toEqual([
              {
                status: 'succeeded',
                output_ref: { kind: 'inline', value: expected },
              },
            ]);
          });
          const snapshots = await fixture.workerQuery<{
            variable_set_revision: number;
            values_json: unknown;
          }>(
            'select run.variable_set_revision,variable_set.values_json from app.workflow_runs run join app.workspace_variable_set_revisions variable_set on variable_set.workspace_id=run.workspace_id and variable_set.revision=run.variable_set_revision where run.id in (with recursive family(id) as (select $1::uuid union all select call.child_run_id from app.workflow_calls call join family on call.parent_run_id=family.id where call.child_run_id is not null) select id from family)',
            [runId],
          );
          expect(snapshots).toHaveLength(3);
          for (const row of snapshots)
            expect(row).toEqual({
              variable_set_revision: expected === 10 ? 1 : 2,
              values_json: { RATE: expected },
            });
        }
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              "select status from app.pending_run_tasks where status='pending'",
              [],
            ),
          ).toHaveLength(1);
        });
        await variables.replace({
          ...scope,
          expectedRevision: 1,
          values: { RATE: 20 },
          idempotencyKey: randomUUID(),
        });
        await finish(source.runId, 10);
        const replay = await runs.replay({
          ...scope,
          sourceRunId: source.runId,
          workflowVersionId: root.workflowVersionId,
          input: {},
          idempotencyKeyHash: 'c'.repeat(64),
          requestHash: 'd'.repeat(64),
          scope: `workflow:${root.workflowId}:replay`,
          checkpointFactory: initialCheckpointFactory({
            catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
          }),
        });
        await finish(replay.run.id, 10);
        const fresh = await accept(root, {});
        await finish(fresh.runId, 20);
      } finally {
        await workers.close();
        await Promise.all([variables.close(), tasks.close(), runs.close()]);
      }
    }, 60000);
  },
);
