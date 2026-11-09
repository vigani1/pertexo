import { maintenanceConfig } from '../../../../../infrastructure/testing/worker-databases.mjs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  inputRequestConfigSchema,
  type JsonValue,
} from '@pertexo/workflow-model';
import {
  createPendingTaskStore,
  createDueNodeWakeupScanner,
} from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  fixture,
  node,
  edge,
  publishGraph,
  accept,
  runtime,
} from '../calls/calls.fixture.js';

describe.runIf(fixture.enabled)('Request Input reconvergence', () => {
  beforeAll(fixture.setup, 60000);
  afterAll(fixture.restoreServicesAndClose);
  it.each([
    ['out', ['out', 'timed_out']],
    ['timed_out', ['out', 'timed_out']],
    ['out', ['timed_out', 'out']],
    ['timed_out', ['timed_out', 'out']],
  ] as const)(
    'loads the persisted task output on %s with links %j',
    async (selected, ports) => {
      const version = await publishGraph({
        settings: { maxRunDurationMs: 60000 },
        nodes: [
          node('manual', 'core.manual'),
          {
            ...node('input', 'core.request_input'),
            config: inputRequestConfigSchema.parse({
              onExpiry: 'continue',
              fields: [
                {
                  id: 'message',
                  name: 'message',
                  label: 'Message',
                  type: 'text',
                },
              ],
            }),
          },
          {
            ...node('finish', 'core.set'),
            inputMappings: {
              result: { kind: 'node_output', nodeId: 'input', path: '$' },
            },
          },
        ],
        edges: [
          edge('manual', 'input'),
          ...ports.map((port, n) => ({
            ...edge('input', 'finish', port),
            id: `edge-${String(n)}`,
          })),
        ],
      });
      const config = parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
        max: 2,
      });
      const tasks = createPendingTaskStore(config),
        due = createDueNodeWakeupScanner(maintenanceConfig(config)),
        workers = await runtime();
      try {
        const run = await accept(version);
        let taskId = '';
        await workers.until(async () => {
          const rows = await fixture.workerQuery<{ id: string }>(
            "select id from app.pending_run_tasks where run_id=$1 and status='pending'",
            [run.runId],
          );
          expect(rows).toHaveLength(1);
          taskId = rows[0]?.id ?? '';
        });
        if (selected === 'out') {
          await tasks.submit({
            workspaceId: fixture.workspaceId,
            actorId: fixture.actorId,
            taskId,
            values: { message: 'Ada' },
            idempotencyKey: randomUUID(),
          });
        } else {
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
        }
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'succeeded' }]);
        });
        const rows = await fixture.workerQuery<{
          node_id: string;
          output_ref: { kind: 'inline'; value: JsonValue };
        }>(
          'select node_id,output_ref from app.node_runs where workflow_run_id=$1 and node_id in ($2,$3)',
          [run.runId, 'input', 'finish'],
        );
        const source = rows.find((row) => row.node_id === 'input');
        expect(source?.output_ref.kind).toBe('inline');
        expect(
          rows.find((row) => row.node_id === 'finish')?.output_ref,
        ).toEqual({
          kind: 'inline',
          value: { result: source?.output_ref.value },
        });
      } finally {
        await Promise.all([tasks.close(), due.close(), workers.close()]);
      }
    },
    30000,
  );
});
