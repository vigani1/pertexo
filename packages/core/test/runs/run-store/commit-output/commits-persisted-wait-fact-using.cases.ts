import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  insertRun,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerCommitsPersistedWaitFactUsing(): void {
  it('commits a persisted wait fact using its physical attempt fence', async () => {
    const invocationKey = 'wait/persisted';
    const resumeAt = '2099-01-01T00:00:00.000Z';
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'persisted',
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
             status,side_effect_class,current_attempt_id,current_attempt_number,
             resume_at,wait_kind
           ) values ($1,$2,$3,'persisted',$4,'{}','waiting','safe',$5,1,$6,
             'node_wait')`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId, resumeAt],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           ) values ($1,$2,$3,1,'succeeded','safe')`,
        [attemptId, workspaceA, nodeRunId],
      );
      await client.query(
        `insert into app.run_events
             (workspace_id,workflow_run_id,sequence,type,payload)
           values ($1,$2,2,'node.waiting',$3::jsonb)`,
        [
          workspaceA,
          runId,
          JSON.stringify({
            nodeRunId,
            attemptId,
            dueAt: resumeAt,
          }),
        ],
      );
    });
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'waiting',
            nextEventSequence: 4,
            invocations: [
              {
                invocationKey,
                nodeId: 'persisted',
                status: 'waiting',
                attemptNumber: 1,
                resumeAt,
              },
            ],
          }),
          events: [
            {
              sequence: 3,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
  });

  it('persists more than sixty-four due waiting-to-ready recoveries without admitting attempts', async () => {
    const dueAt = '2020-01-01T00:00:00.000Z';
    const invocations = Array.from({ length: 65 }, (_, index) => ({
      invocationKey: `bulk-due/${String(index).padStart(2, '0')}`,
      nodeId: `node-${String(index).padStart(2, '0')}`,
      status: 'waiting' as const,
      attemptNumber: 1,
      resumeAt: dueAt,
      waitKind: 'node_wait' as const,
    }));
    const runId = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations,
      }),
      status: 'waiting',
    });
    const physicalNodeIds = invocations.map(() => randomUUID());
    const physicalAttemptIds = invocations.map(() => randomUUID());
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number,
             resume_at,wait_kind
           )
           select physical_id,$1,$2,node_id,invocation_key,'{}','waiting','safe',
             attempt_id,1,$3,'node_wait'
           from unnest($4::uuid[],$5::uuid[],$6::varchar[],$7::varchar[])
             as due(physical_id,attempt_id,invocation_key,node_id)`,
        [
          workspaceA,
          runId,
          dueAt,
          physicalNodeIds,
          physicalAttemptIds,
          invocations.map(({ invocationKey }) => invocationKey),
          invocations.map(({ nodeId }) => nodeId),
        ],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class
           )
           select attempt_id,$1,node_run_id,1,'failed','safe'
           from unnest($2::uuid[],$3::uuid[]) as attempt(attempt_id,node_run_id)`,
        [workspaceA, physicalAttemptIds, physicalNodeIds],
      );
    });
    const events = [
      ...invocations.map((invocation, index) => ({
        sequence: index + 2,
        name: 'node.ready' as const,
        occurredAt: '2026-08-21T00:00:00.000Z',
        invocationKey: invocation.invocationKey,
        nodeId: invocation.nodeId,
        attemptNumber: 1,
      })),
    ];
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'waiting',
            nextEventSequence: 67,
            readySet: invocations.map(({ invocationKey }) => invocationKey),
            invocations: invocations.map((value) => ({
              invocationKey: value.invocationKey,
              nodeId: value.nodeId,
              status: 'ready' as const,
              attemptNumber: value.attemptNumber,
            })),
          }),
          events,
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        due_payloads_valid: boolean;
        new_attempts: number;
        ready: number;
      }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=$1 and status='ready') ready,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1 and attempt.attempt_number > 1) new_attempts,
             (select count(*)=65 and bool_and(
                jsonb_typeof(payload)='object'
                and (payload->>'attemptNumber')::int=1
                and payload ? 'nodeRunId' and payload ? 'attemptId'
              ) from app.run_events where workflow_run_id=$1 and type='node.ready') due_payloads_valid`,
        [runId],
      ),
    );
    expect(proof.rows[0]).toEqual({
      ready: 65,
      new_attempts: 0,
      due_payloads_valid: true,
    });
  });
}
