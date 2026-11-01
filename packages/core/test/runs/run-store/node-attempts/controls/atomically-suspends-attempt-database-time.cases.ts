import { it, expect } from 'vitest';

import {
  asAdmin,
  asRuntime,
  checkpoint,
  createDueNodeWakeupScanner,
  databaseUrl,
  insertRun,
  nodeAttemptStore,
  parseDatabaseConfig,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';
import { storedNodeRunInput, admitWaitAttempt } from '../fixture.js';

export function registerAtomicallySuspendsAttemptDatabaseTime(): void {
  it('atomically suspends an attempt from database time without an early wakeup', async () => {
    const runId = await insertRun({
      inputRef: { kind: 'inline', value: { held: true } },
    });
    const invocationKey = `${versionA}|wait|b:|i:`;
    const { admission, claimed } = await admitWaitAttempt(runId, invocationKey);
    const storedInput = () => storedNodeRunInput(admission.nodeRunId);
    await expect(
      nodeAttemptStore.recordInput?.({
        lease: claimed.lease,
        input: { attempt: 1 },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ recorded: true });

    const suspended = await nodeAttemptStore.complete({
      lease: claimed.lease,
      outcome: {
        status: 'suspended',
        output: { held: true },
        durationSeconds: 1,
      },
      signal: new AbortController().signal,
    });
    expect(suspended).toMatchObject({ kind: 'committed' });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: {
          status: 'suspended',
          output: { held: true },
          durationSeconds: 1,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });

    // Duration is used only to establish the first durable due time. Replays
    // cannot recompute that fixed wait, even after run control is observed.
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: {
          status: 'suspended',
          output: { held: true },
          durationSeconds: 2_592_000,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    await asAdmin((client) =>
      client.query(
        `update app.workflow_runs
            set cancel_requested_at=clock_timestamp(),
                cancel_requested_by='suspension-replay-test',
                cancel_reason='prove committed replay precedence'
          where workspace_id=$1 and id=$2`,
        [workspaceA, runId],
      ),
    );
    try {
      await expect(
        nodeAttemptStore.complete({
          lease: claimed.lease,
          outcome: {
            status: 'suspended',
            output: { held: true },
            durationSeconds: 1,
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    } finally {
      await asAdmin((client) =>
        client.query(
          `update app.workflow_runs
              set cancel_requested_at=null,cancel_requested_by=null,
                  cancel_reason=null
            where workspace_id=$1 and id=$2`,
          [workspaceA, runId],
        ),
      );
    }

    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempt_status: string;
        node_status: string;
        resume_at: Date;
        wait_kind: string;
        no_early_resume: boolean;
        waiting_events: number;
        suspension_outboxes: number;
      }>(
        `select attempt.status attempt_status,node.status node_status,node.resume_at,node.wait_kind,
                  node.resume_at > clock_timestamp() no_early_resume,
                  (select count(*)::int from app.run_events
                    where workflow_run_id=$1 and type='node.waiting') waiting_events,
                  (select count(*)::int from app.outbox_events
                    where aggregate_id=$1 and job_name='advance-workflow-run'
                      and id=$3) suspension_outboxes
           from app.node_attempts attempt
           join app.node_runs node on node.id=attempt.node_run_id
           where attempt.id=$2`,
        [runId, admission.attemptId, suspended.outboxEventId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({
      attempt_status: 'succeeded',
      node_status: 'waiting',
      wait_kind: 'node_wait',
      no_early_resume: true,
      waiting_events: 1,
      suspension_outboxes: 1,
    });
    expect(proof.rows[0]?.resume_at).toBeInstanceOf(Date);
    const scanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      await scanner.claimDueWakeups(100);
      const afterScan = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count from app.outbox_events
             where aggregate_id=$1 and job_name='advance-workflow-run'`,
          [runId],
        ),
      );
      expect(afterScan.rows[0]?.count).toBe(2);
    } finally {
      await scanner.close();
    }

    const resumeAt = proof.rows[0]?.resume_at.toISOString();
    if (resumeAt === undefined) throw new Error('resume time missing');
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 1,
          expectedNextEventSequence: 4,
          consumedThroughEventSequence: 5,
          checkpoint: checkpoint({
            revision: 2,
            runStatus: 'waiting',
            nextEventSequence: 7,
            admittedInvocationKeys: [invocationKey],
            invocations: [
              {
                invocationKey,
                nodeId: 'wait',
                status: 'waiting',
                attemptNumber: 1,
                resumeAt,
                waitKind: 'node_wait',
                output: { kind: 'inline', attemptId: admission.attemptId },
              },
            ],
          }),
          events: [
            {
              sequence: 6,
              name: 'run.waiting',
              occurredAt: '2026-08-21T00:00:01.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 2 });
    // The persisted wait is derived from PostgreSQL time and duplicated inside
    // the immutable checkpoint, so this intentionally crosses the real clock.
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const dueScanner = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 1,
        ownerRole: 'pertexo_owner',
      }),
    );
    try {
      await dueScanner.claimDueWakeups(100);
    } finally {
      await dueScanner.close();
    }
    const resumed = await ownedDeliveryStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 2,
        expectedNextEventSequence: 7,
        consumedThroughEventSequence: 6,
        checkpoint: checkpoint({
          revision: 3,
          runStatus: 'running',
          nextEventSequence: 8,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'wait',
              status: 'running',
              attemptNumber: 2,
              output: { kind: 'inline', attemptId: admission.attemptId },
            },
          ],
        }),
        events: [
          {
            sequence: 7,
            name: 'node.ready',
            occurredAt: resumeAt,
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 1,
          },
        ],
        nodeRunAdmissions: [],
        attempts: [
          {
            admissionKind: 'wait_resume',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 2,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (resumed.kind !== 'committed') throw new Error('resume did not commit');
    const resumeAdmission = resumed.admittedAttempts[0];
    if (resumeAdmission === undefined)
      throw new Error('resume attempt missing');
    const resumeDelivery = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
           where aggregate_id=$1 and job_name='execute-node-attempt'`,
          [resumeAdmission.attemptId],
        ),
    );
    const resumeOutbox = resumeDelivery.rows[0];
    if (resumeOutbox === undefined) throw new Error('resume delivery missing');
    const resumeClaim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: resumeAdmission.nodeRunId,
      attemptId: resumeAdmission.attemptId,
      delivery: {
        outboxEventId: resumeOutbox.id,
        payloadChecksum: resumeOutbox.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-wait-resume',
      signal: new AbortController().signal,
    });
    if (resumeClaim.kind !== 'claimed')
      throw new Error('resume was not claimed');
    expect(resumeClaim.lease.admissionKind).toBe('wait_resume');
    // Resuming receives no new input, so the input the wait received stays,
    // and the attempt that recorded it can no longer write once superseded.
    const waitInput = {
      kind: 'inline',
      value: { attempt: 1 },
    };
    await expect(storedInput()).resolves.toEqual(waitInput);
    await expect(
      nodeAttemptStore.recordInput?.({
        lease: claimed.lease,
        input: { attempt: 1, late: true },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ recorded: false });
    await expect(storedInput()).resolves.toEqual(waitInput);
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: {
          status: 'suspended',
          output: { held: true },
          durationSeconds: 9,
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    await expect(
      nodeAttemptStore.loadInputs({
        lease: resumeClaim.lease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      control: { kind: 'none' },
      resumeOutput: { held: true },
    });
    await expect(
      nodeAttemptStore.complete({
        lease: resumeClaim.lease,
        outcome: { status: 'succeeded', output: { held: true } },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempts: number;
        node_status: string;
        wait_kind: string | null;
      }>(
        `select node.status node_status,node.wait_kind,count(attempt.id)::int attempts
           from app.node_runs node join app.node_attempts attempt on attempt.node_run_id=node.id
           where node.id=$1 group by node.id`,
        [resumeAdmission.nodeRunId],
      ),
    );
    expect(terminal.rows[0]).toEqual({
      attempts: 2,
      node_status: 'succeeded',
      wait_kind: null,
    });
  });
}
