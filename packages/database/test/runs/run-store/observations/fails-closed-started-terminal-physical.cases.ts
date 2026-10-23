import { it, expect } from 'vitest';
import {
  CoordinatorRunStateCorruptError,
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerFailsClosedStartedTerminalPhysical(): void {
  it('fails closed for started and terminal physical status or output divergence', async () => {
    for (const variant of [
      {
        name: 'started-status',
        eventType: 'node.started',
        nodeStatus: 'running',
        attemptStatus: 'succeeded',
        nodeValue: null,
        attemptValue: null,
      },
      {
        name: 'progress-status',
        eventType: 'node.progress',
        nodeStatus: 'failed',
        attemptStatus: 'succeeded',
        nodeValue: null,
        attemptValue: null,
      },
      {
        name: 'terminal-status',
        eventType: 'node.succeeded',
        nodeStatus: 'running',
        attemptStatus: 'succeeded',
        nodeValue: { kind: 'inline', value: { ok: true } },
        attemptValue: {
          kind: 'inline',
          value: { ok: true },
        },
      },
      {
        name: 'terminal-output',
        eventType: 'node.succeeded',
        nodeStatus: 'succeeded',
        attemptStatus: 'succeeded',
        nodeValue: {
          kind: 'inline',
          value: { side: 'node' },
        },
        attemptValue: {
          kind: 'inline',
          value: { side: 'attempt' },
        },
      },
    ] as const) {
      const invocationKey = `physical/${variant.name}`;
      const runId = await insertRun({
        schedulerState: checkpoint({
          runStatus: 'running',
          invocations: [
            {
              invocationKey,
              nodeId: variant.name,
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        status: 'running',
      });
      const nodeRunId = randomUUID();
      const attemptId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.node_runs (
               id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
               status,side_effect_class,current_attempt_id,current_attempt_number,output_ref
             ) values ($1,$2,$3,$4,$5,'{}',$6,'safe',$7,1,$8::jsonb)`,
          [
            nodeRunId,
            workspaceA,
            runId,
            variant.name,
            invocationKey,
            variant.nodeStatus,
            attemptId,
            variant.nodeValue === null
              ? null
              : JSON.stringify(variant.nodeValue),
          ],
        );
        await client.query(
          `insert into app.node_attempts (
               id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
             ) values ($1,$2,$3,1,$4,'safe',$5::jsonb)`,
          [
            attemptId,
            workspaceA,
            nodeRunId,
            variant.attemptStatus,
            variant.attemptValue === null
              ? null
              : JSON.stringify(variant.attemptValue),
          ],
        );
        await client.query(
          `insert into app.run_events
               (workspace_id,workflow_run_id,sequence,type,payload)
             values ($1,$2,2,$3,$4::jsonb)`,
          [
            workspaceA,
            runId,
            variant.eventType,
            JSON.stringify({ nodeRunId, attemptId }),
          ],
        );
      });
      await expect(
        ownedDeliveryStore.loadAdvanceState({
          workspaceId: workspaceA,
          runId,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    }
  });

  it('fails closed for a terminal fact whose stored output is not a tagged execution value', async () => {
    const invocationKey = 'version-a/corrupt-output';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'corrupt-output',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      status: 'running',
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
           ) values ($1,$2,$3,'corrupt-output',$4,'{}','succeeded','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref
           ) values ($1,$2,$3,1,'succeeded','safe','{"kind":"inline"}'::jsonb)`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.succeeded',$3::jsonb)`,
        [workspaceA, runId, JSON.stringify({ nodeRunId, attemptId })],
      );
    });

    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
  });
}
