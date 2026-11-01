import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formConfigSchema,
  inputRequestConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  createPendingTaskStore,
  createDueNodeWakeupScanner,
} from '@pertexo/core/runs';
import { createFormStore } from '@pertexo/core/triggers';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createInitialCheckpoint } from '@pertexo/core/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  fixture,
  node,
  edge,
  publishGraph,
  runtime,
} from '../calls/fixtures.js';
function graph(handler = false): WorkflowGraph {
  return {
    settings: { maxRunDurationMs: 60000 },
    nodes: [
      {
        ...node('form', 'core.form'),
        config: formConfigSchema.parse({
          fields: [
            { id: 'message', name: 'message', label: 'Message', type: 'text' },
            {
              id: 'channels',
              name: 'channels',
              label: 'Channels',
              type: 'multi_select',
              options: ['Email', 'SMS'],
              required: false,
            },
          ],
        }),
      },
      {
        ...node('input', 'core.request_input'),
        config: inputRequestConfigSchema.parse({
          fields: [
            { id: 'message', name: 'message', label: 'Message', type: 'text' },
            {
              id: 'channels',
              name: 'channels',
              label: 'Channels',
              type: 'multi_select',
              options: ['Email', 'SMS'],
              required: false,
            },
          ],
        }),
        inputMappings: {
          details: {
            kind: 'expression',
            language: 'jsonata',
            expression: '{"Original message": nodeOutputs.form.values.message}',
          },
          prefill: { kind: 'node_output', nodeId: 'form', path: '$.values' },
        },
      },
      {
        ...node('finish', 'core.terminate'),
        inputMappings: {
          result: {
            kind: 'node_output',
            nodeId: 'input',
            path: '$.values',
          },
        },
      },
      ...(handler ? [node('expired', 'core.terminate')] : []),
    ],
    edges: [
      edge('form', 'input'),
      edge('input', 'finish'),
      ...(handler ? [edge('input', 'expired', '__failure')] : []),
    ],
  };
}
describe.runIf(fixture.enabled)(
  'Form and Request input through the existing worker',
  () => {
    beforeAll(fixture.setup, 60000);
    afterAll(fixture.restoreServicesAndClose);
    const config = () =>
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
        max: 2,
      });
    const forms = () =>
      createFormStore(config(), (version) =>
        createInitialCheckpoint(version, {
          catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG),
        }),
      );
    it('admits a member form and resumes captured input once after restart, projecting its values downstream', async () => {
      const version = await publishGraph(graph());
      await fixture.ownerQuery(
        'update app.workflows set published_version_id=$2 where id=$1',
        [version.workflowId, version.workflowVersionId],
      );
      const store = forms(),
        tasks = createPendingTaskStore(config()),
        workers = await runtime();
      try {
        const run = await store.submit({
          workspaceId: fixture.workspaceId,
          workflowId: version.workflowId,
          actorId: fixture.actorId,
          versionId: version.workflowVersionId,
          values: { message: 'Original', channels: ['SMS', 'Email'] },
          idempotencyKey: randomUUID(),
        });
        if (!run.accepted) throw new Error('Expected an admitted form run');
        let taskId = '';
        await workers.until(async () => {
          const rows = await fixture.workerQuery<{ id: string }>(
            "select id from app.pending_run_tasks where run_id=$1 and kind='input_request' and status='pending'",
            [run.runId],
          );
          expect(rows).toHaveLength(1);
          taskId = rows[0]?.id ?? '';
        });
        await workers.restart();
        const captured = await tasks.read({
          workspaceId: fixture.workspaceId,
          taskId,
          actorId: fixture.actorId,
        });
        expect(captured).toMatchObject({
          details: { 'Original message': 'Original' },
          prefill: { message: 'Original', channels: ['SMS', 'Email'] },
        });
        const command = {
          workspaceId: fixture.workspaceId,
          taskId,
          actorId: fixture.actorId,
          values: { message: 'Member response', channels: ['Email'] },
          idempotencyKey: randomUUID(),
        };
        await tasks.submit(command);
        expect((await tasks.submit(command)).replayed).toBe(true);
        expect(
          await tasks.read({
            workspaceId: fixture.workspaceId,
            taskId,
            actorId: fixture.actorId,
          }),
        ).toMatchObject({
          details: { 'Original message': 'Original' },
          prefill: { message: 'Original', channels: ['SMS', 'Email'] },
        });
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'succeeded' }]);
        });
        expect(
          await fixture.workerQuery(
            'select output_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
            [run.runId, 'finish'],
          ),
        ).toEqual([
          {
            output_ref: {
              kind: 'inline',
              value: {
                result: { message: 'Member response', channels: ['Email'] },
              },
            },
          },
        ]);
        expect(
          await fixture.workerQuery(
            'select count(*)::int n from app.node_attempts attempt join app.pending_run_tasks task on task.node_run_id=attempt.node_run_id where task.id=$1',
            [taskId],
          ),
        ).toEqual([{ n: 1 }]);
      } finally {
        await Promise.all([store.close(), tasks.close(), workers.close()]);
      }
    }, 30000);
    it('routes an expired input request through a failure link without another declaration', async () => {
      const version = await publishGraph(graph(true));
      await fixture.ownerQuery(
        'update app.workflows set published_version_id=$2 where id=$1',
        [version.workflowId, version.workflowVersionId],
      );
      const store = forms(),
        due = createDueNodeWakeupScanner(config()),
        workers = await runtime();
      try {
        const run = await store.submit({
          workspaceId: fixture.workspaceId,
          workflowId: version.workflowId,
          actorId: fixture.actorId,
          versionId: version.workflowVersionId,
          values: { message: 'Expiry' },
          idempotencyKey: randomUUID(),
        });
        if (!run.accepted) throw new Error('Expected an admitted form run');
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status from app.pending_run_tasks where run_id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'pending' }]);
        });
        await workers.pause();
        await fixture.ownerQuery(
          "update app.pending_run_tasks set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' where run_id=$1",
          [run.runId],
        );
        await fixture.ownerQuery(
          "update app.node_runs set resume_at=clock_timestamp()-interval '1 second' where workflow_run_id=$1 and control_kind='human_task'",
          [run.runId],
        );
        await due.claimDueWakeups(20);
        await workers.restart();
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status,handled_failure_count from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'succeeded', handled_failure_count: 1 }]);
        });
      } finally {
        await Promise.all([store.close(), due.close(), workers.close()]);
      }
    }, 30000);
  },
);
