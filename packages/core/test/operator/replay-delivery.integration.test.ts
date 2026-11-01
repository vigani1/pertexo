import { randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OperatorRunReplayMismatchError } from '../../src/operator/replay/contract.js';
import { createScheduleTriggerTestEnvironment } from '../support/schedule-triggers.js';

const schedule = createScheduleTriggerTestEnvironment({
  includeOperator: true,
});
const { ownerQuery, versionId, workerQuery, workspaceId } = schedule;
let sourceRunId = '';

beforeAll(async () => {
  sourceRunId = await schedule.initialize();
});
afterAll(() => schedule.close());

async function requested() {
  const commandId = randomUUID();
  const { result } = await schedule.operator.replayRun({
    actorRef: 'operator:pin',
    commandId,
    dryRun: false,
    reason: 'pin replay delivery',
    runInput: { pinned: true },
    sourceRunId,
    workflowVersionId: versionId,
    workspaceId,
  });
  const outboxEventId = String(result.outboxEventId);
  return {
    commandId,
    outboxEventId,
    delivery: {
      outboxEventId,
      payloadChecksum: canonicalOutboxPayloadChecksum({
        commandId,
        outboxEventId,
        workspaceId,
      }),
    },
  };
}

type Requested = Awaited<ReturnType<typeof requested>>;

async function facts({ commandId, outboxEventId }: Requested) {
  const { rows } = await workerQuery<{
    runs: number;
    request: string;
    command: string;
    outcome: string;
    receipts: number;
  }>(
    `select
       (select count(*)::int from app.workflow_runs where replay_command_id=$1) runs,
       (select status from app.operator_run_replay_requests where command_id=$1) request,
       (select status from app.operator_commands where id=$1) command,
       (select outcome from app.operator_commands where id=$1) outcome,
       (select count(*)::int from app.inbox_receipts where message_id=$2) receipts`,
    [commandId, outboxEventId],
  );
  return rows[0];
}

const untouched = {
  runs: 0,
  request: 'pending',
  command: 'pending',
  outcome: 'replay_requested',
  receipts: 0,
};

/** Edits the stored outbox row so it no longer backs what the queue delivered. */
const storedRowChanges: readonly (readonly [string, string])[] = [
  ['its job', "job_name='advance-workflow-run'"],
  ['its aggregate type', "aggregate_type='workflow-run'"],
  ['its aggregate', `aggregate_id='${randomUUID()}'`],
  ['its checksum', `payload_checksum='${'c'.repeat(64)}'`],
  ['its payload', `payload='{"commandId":"${randomUUID()}"}'::jsonb`],
];

describe('a replay delivery the stored outbox row does not back', () => {
  it.each([
    [
      'a wrong checksum',
      (world: Requested) => ({
        commandId: world.commandId,
        delivery: {
          ...world.delivery,
          payloadChecksum: 'c'.repeat(64),
        },
      }),
    ],
    [
      'an outbox row that does not exist',
      (world: Requested) => ({
        commandId: world.commandId,
        delivery: { ...world.delivery, outboxEventId: randomUUID() },
      }),
    ],
    [
      "another command's ID",
      (world: Requested) => ({
        commandId: randomUUID(),
        delivery: world.delivery,
      }),
    ],
  ])('refuses %s and creates no run', async (_name, tamper) => {
    const world = await requested();
    await expect(
      schedule.replayStore.replay({ ...tamper(world), workspaceId }),
    ).rejects.toBeInstanceOf(OperatorRunReplayMismatchError);
    expect(await facts(world)).toEqual(untouched);

    // The refused delivery claimed nothing: the genuine one still goes through.
    await expect(
      schedule.replayStore.replay({
        commandId: world.commandId,
        delivery: world.delivery,
        workspaceId,
      }),
    ).resolves.toMatchObject({ kind: 'processed' });
    expect(await facts(world)).toMatchObject({
      runs: 1,
      request: 'completed',
      command: 'completed',
      outcome: 'replay_created',
    });
  });

  it("refuses another command's delivery and leaves both commands waiting", async () => {
    const [first, second] = await Promise.all([requested(), requested()]);
    await expect(
      schedule.replayStore.replay({
        commandId: first.commandId,
        delivery: second.delivery,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(OperatorRunReplayMismatchError);
    expect(await facts(first)).toEqual(untouched);
    expect(await facts(second)).toEqual(untouched);
  });

  it.each(storedRowChanges)(
    'refuses a delivery once the stored row changed %s, and creates no run',
    async (_name, change) => {
      const world = await requested();
      await ownerQuery(`update app.outbox_events set ${change} where id=$1`, [
        world.outboxEventId,
      ]);
      await expect(
        schedule.replayStore.replay({
          commandId: world.commandId,
          delivery: world.delivery,
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(OperatorRunReplayMismatchError);
      expect(await facts(world)).toEqual(untouched);
    },
  );
});

describe('failing a replay', () => {
  const fail = (commandId: string, safeErrorCode: string) =>
    schedule.replayStore.fail({ commandId, safeErrorCode, workspaceId });

  async function failure(commandId: string) {
    const { rows } = await workerQuery<{
      status: string;
      safe_error_code: string | null;
      result_run_id: string | null;
    }>(
      `select status,safe_error_code,result_run_id
       from app.operator_run_replay_requests where command_id=$1`,
      [commandId],
    );
    return rows[0];
  }

  it('settles a pending replay as failed, and then refuses its delivery', async () => {
    const world = await requested();
    await fail(world.commandId, 'version_not_executable');
    expect(await failure(world.commandId)).toEqual({
      status: 'failed',
      safe_error_code: 'version_not_executable',
      result_run_id: null,
    });
    expect(await facts(world)).toMatchObject({
      command: 'failed',
      outcome: 'replay_failed',
    });
    await expect(
      schedule.replayStore.replay({
        commandId: world.commandId,
        delivery: world.delivery,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(OperatorRunReplayMismatchError);
    expect(await facts(world)).toMatchObject({ runs: 0 });
  });

  it('keeps the first failure when it fails again', async () => {
    const world = await requested();
    await fail(world.commandId, 'first_failure');
    await expect(
      fail(world.commandId, 'second_failure'),
    ).resolves.toBeUndefined();
    expect(await failure(world.commandId)).toMatchObject({
      safe_error_code: 'first_failure',
    });
    const record = await schedule.operator.getCommand({
      actorRef: 'operator:pin',
      commandId: world.commandId,
      reason: 'read the first failure',
      workspaceId,
    });
    expect(record).toMatchObject({
      status: 'failed',
      outcome: 'replay_failed',
      result: { safeErrorCode: 'first_failure' },
    });
  });

  it('keeps a created run when a late failure arrives', async () => {
    const world = await requested();
    const processed = await schedule.replayStore.replay({
      commandId: world.commandId,
      delivery: world.delivery,
      workspaceId,
    });
    if (processed.kind !== 'processed') throw new Error('Not processed');
    await expect(
      fail(world.commandId, 'late_failure'),
    ).resolves.toBeUndefined();
    expect(await failure(world.commandId)).toEqual({
      status: 'completed',
      safe_error_code: null,
      result_run_id: processed.runId,
    });
    expect(await facts(world)).toMatchObject({
      runs: 1,
      command: 'completed',
      outcome: 'replay_created',
    });
  });
});
