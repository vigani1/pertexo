import { ownerQuery, versionId, workerQuery, workspaceId } from './fixture.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '../../../../src/outbox/events.repository.js';

import { schedule, replaySourceRunId } from './fixture.js';

export function registerRequestsWorkerAdmitsReplayImmutable(): void {
  it('requests and worker-admits a replay with immutable lineage', async () => {
    await expect(
      schedule.operator.replayRun({
        actorRef: 'integration-operator',
        commandId: randomUUID(),
        dryRun: true,
        reason: 'inspect explicit replay',
        runInput: { explicit: 'operator-replay' },
        sourceRunId: replaySourceRunId,
        workflowVersionId: versionId,
        workspaceId,
      }),
    ).resolves.toMatchObject({
      outcome: 'would_request',
      replayed: false,
      status: 'completed',
    });
    const commandId = randomUUID();
    const command = {
      actorRef: 'integration-operator',
      commandId,
      dryRun: false,
      reason: 'replay after reconciled provider outcome',
      runInput: { explicit: 'operator-replay' },
      sourceRunId: replaySourceRunId,
      workflowVersionId: versionId,
      workspaceId,
    } as const;
    const requested = await schedule.operator.replayRun(command);
    expect(requested).toMatchObject({
      outcome: 'replay_requested',
      replayed: false,
      status: 'pending',
    });
    expect(await schedule.operator.replayRun(command)).toEqual({
      ...requested,
      replayed: true,
    });
    await expect(
      schedule.operator.replayRun({
        ...command,
        runInput: { conflicting: true },
      }),
    ).rejects.toThrow('conflicts');

    const outboxEventId = requested.result.outboxEventId;
    expect(outboxEventId).toEqual(expect.any(String));
    const processed = await schedule.replayStore.replay({
      commandId,
      delivery: {
        outboxEventId: String(outboxEventId),
        payloadChecksum: canonicalOutboxPayloadChecksum({
          commandId,
          outboxEventId,
          workspaceId,
        }),
      },
      workspaceId,
    });
    expect(processed.kind).toBe('processed');
    expect(typeof processed.runId).toBe('string');
    const replayRunId = processed.runId;
    await expect(
      schedule.replayStore.replay({
        commandId,
        delivery: {
          outboxEventId: String(outboxEventId),
          payloadChecksum: canonicalOutboxPayloadChecksum({
            commandId,
            outboxEventId,
            workspaceId,
          }),
        },
        workspaceId,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      schedule.replayStore.fail({
        commandId,
        safeErrorCode: 'operator.late_failure',
        workspaceId,
      }),
    ).resolves.toBeUndefined();
    const lineage = await ownerQuery<{
      replay_command_id: string;
      replay_source_run_id: string;
      trigger_type: string;
      workflow_version_id: string;
    }>(
      `select replay_command_id,replay_source_run_id,trigger_type,workflow_version_id
       from app.workflow_runs where id=$1`,
      [replayRunId],
    );
    expect(lineage.rows[0]).toEqual({
      replay_command_id: commandId,
      replay_source_run_id: replaySourceRunId,
      trigger_type: 'replay',
      workflow_version_id: versionId,
    });
    const completed = await schedule.operator.getCommand({
      actorRef: 'integration-operator',
      commandId,
      reason: 'verify replay completion',
      workspaceId,
    });
    expect(completed?.completedAt).toBeInstanceOf(Date);
    expect(completed).toMatchObject({
      outcome: 'replay_created',
      status: 'completed',
      result: { resultRunId: replayRunId },
    });
    await ownerQuery(
      `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
       where id=$1`,
      [replayRunId],
    );
  });

  it('atomically arbitrates replay completion against concurrent failure', async () => {
    const commandId = randomUUID();
    const requested = await schedule.operator.replayRun({
      actorRef: 'integration-operator',
      commandId,
      dryRun: false,
      reason: 'race replay completion with failure persistence',
      runInput: { race: 'completion-vs-failure' },
      sourceRunId: replaySourceRunId,
      workflowVersionId: versionId,
      workspaceId,
    });
    const outboxEventId = String(requested.result.outboxEventId);
    const delivery = {
      outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum({
        commandId,
        outboxEventId,
        workspaceId,
      }),
    };

    const [completion, failure] = await Promise.allSettled([
      schedule.replayStore.replay({ commandId, delivery, workspaceId }),
      schedule.replayStore.fail({
        commandId,
        safeErrorCode: 'operator.race_failure',
        workspaceId,
      }),
    ]);
    expect(failure.status).toBe('fulfilled');

    const facts = await workerQuery<{
      command_outcome: string;
      command_status: string;
      completed_receipts: number;
      replay_runs: number;
      request_error: string | null;
      request_status: string;
    }>(
      `select command.status command_status,command.outcome command_outcome,
          request.status request_status,request.safe_error_code request_error,
          (select count(*)::integer from app.workflow_runs run
            where run.workspace_id=$2 and run.replay_command_id=$1) replay_runs,
          (select count(*)::integer from app.inbox_receipts receipt
            where receipt.workspace_id=$2
              and receipt.consumer_name='operator-run-replay'
              and receipt.message_id=$3 and receipt.completed_at is not null)
            completed_receipts
       from app.operator_commands command
       join app.operator_run_replay_requests request
         on request.command_id=command.id
       where command.id=$1 and request.workspace_id=$2`,
      [commandId, workspaceId, outboxEventId],
    );
    const fact = facts.rows[0];
    if (fact === undefined) throw new Error('Replay race state missing');
    expect(fact.request_status).toBe(fact.command_status);
    if (fact.request_status === 'completed') {
      expect(completion).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'processed' },
      });
      expect(fact).toMatchObject({
        command_outcome: 'replay_created',
        command_status: 'completed',
        completed_receipts: 1,
        replay_runs: 1,
        request_error: null,
      });
    } else {
      expect(fact.request_status).toBe('failed');
      expect(completion.status).toBe('rejected');
      expect(fact).toEqual({
        command_outcome: 'replay_failed',
        command_status: 'failed',
        completed_receipts: 0,
        replay_runs: 0,
        request_error: 'operator.race_failure',
        request_status: 'failed',
      });
    }
  });
}
