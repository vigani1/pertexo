import { parseDatabaseConfig } from '@pertexo/database/platform';
import { randomUUID } from 'node:crypto';

import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OperatorRunReplayMismatchError } from '../../src/operator/replay/operator-replay.js';
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

it('rolls back a replay canceled while its request is locked and lets the same delivery retry once', async () => {
  const world = await requested();
  const blocker = await schedule.worker.connect();
  await blocker.query('begin');
  await blocker.query("select set_config('app.workspace_id',$1,true)", [
    workspaceId,
  ]);
  expect(
    (
      await blocker.query(
        'select command_id from app.operator_run_replay_requests where command_id=$1 for update',
        [world.commandId],
      )
    ).rowCount,
  ).toBe(1);
  let locked = true;
  const unlock = async () => {
    if (!locked) return;
    locked = false;
    await blocker.query('rollback');
    blocker.release();
  };
  const controller = new AbortController();
  const replaying = schedule.replayStore
    .replay({
      commandId: world.commandId,
      delivery: world.delivery,
      workspaceId,
      signal: controller.signal,
    })
    .catch((error: unknown) => error);
  try {
    await expect
      .poll(async () => {
        await blocker.query('select pg_stat_clear_snapshot()');
        const result = await blocker.query<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%operator_run_replay_requests%') waiting`,
        );
        return result.rows[0]?.waiting;
      })
      .toBe(true);
    controller.abort(new Error('stop replay'));
    await unlock();
    expect(await replaying).toMatchObject({ name: 'AbortError' });
    expect(await facts(world)).toEqual(untouched);
  } finally {
    controller.abort();
    await unlock();
    await replaying;
  }
  await expect(
    schedule.replayStore.replay({
      commandId: world.commandId,
      delivery: world.delivery,
      workspaceId,
    }),
  ).resolves.toMatchObject({ kind: 'processed' });
  expect(await facts(world)).toEqual({
    runs: 1,
    request: 'completed',
    command: 'completed',
    outcome: 'replay_created',
    receipts: 1,
  });
  await schedule.replayStore.replay({
    commandId: world.commandId,
    delivery: world.delivery,
    workspaceId,
  });
  expect(await facts(world)).toEqual({
    runs: 1,
    request: 'completed',
    command: 'completed',
    outcome: 'replay_created',
    receipts: 1,
  });
});

it('stores immutable replay lineage and input, then returns duplicate without another effect', async () => {
  const world = await requested();
  const input = {
    commandId: world.commandId,
    delivery: world.delivery,
    workspaceId,
  };
  const processed = await schedule.replayStore.replay(input);
  if (processed.kind !== 'processed') throw new Error('Replay not processed');
  const rows = await workerQuery<Record<string, unknown>>(
    `select replay_command_id,replay_source_run_id,workflow_id,workflow_version_id,started_by,input_ref from app.workflow_runs where id=$1`,
    [processed.runId],
  );
  const source = await workerQuery<{ started_by: string | null }>(
    'select started_by from app.workflow_runs where id=$1',
    [sourceRunId],
  );
  expect(rows.rows).toEqual([
    {
      replay_command_id: world.commandId,
      replay_source_run_id: sourceRunId,
      workflow_id: schedule.workflowId,
      workflow_version_id: versionId,
      started_by: source.rows[0]?.started_by,
      input_ref: { kind: 'inline', value: { pinned: true } },
    },
  ]);
  const before = await facts(world);
  await expect(schedule.replayStore.replay(input)).resolves.toEqual({
    kind: 'duplicate',
  });
  expect(await facts(world)).toEqual(before);
});

it('refuses an invalid signal without consuming the genuine replay', async () => {
  const world = await requested();
  await expect(
    schedule.replayStore.replay({
      commandId: world.commandId,
      delivery: world.delivery,
      workspaceId,
      signal: {} as AbortSignal,
    }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(await facts(world)).toEqual(untouched);
});

it.each(['missing', 'completed'] as const)(
  'refuses a %s durable request without consuming its delivery',
  async (state) => {
    const world = await requested();
    const changed =
      state === 'missing'
        ? await ownerQuery(
            'delete from app.operator_run_replay_requests where command_id=$1',
            [world.commandId],
          )
        : await ownerQuery(
            "update app.operator_run_replay_requests set status='completed', result_run_id=$2, completed_at=clock_timestamp() where command_id=$1",
            [world.commandId, sourceRunId],
          );
    expect(changed.rowCount).toBe(1);
    const before = await facts(world);
    await expect(
      schedule.replayStore.replay({
        commandId: world.commandId,
        delivery: world.delivery,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(OperatorRunReplayMismatchError);
    expect(await facts(world)).toEqual(before);
  },
);

it.each(['commandId', 'outboxEventId', 'workspaceId'] as const)(
  'refuses a stored payload with a different %s',
  async (key) => {
    const world = await requested();
    const payload = {
      commandId: world.commandId,
      outboxEventId: world.outboxEventId,
      workspaceId,
      [key]: randomUUID(),
    };
    const checksum = canonicalOutboxPayloadChecksum(payload);
    await ownerQuery(
      'update app.outbox_events set payload=$2::jsonb,payload_checksum=$3 where id=$1',
      [world.outboxEventId, JSON.stringify(payload), checksum],
    );
    await expect(
      schedule.replayStore.replay({
        commandId: world.commandId,
        workspaceId,
        delivery: { ...world.delivery, payloadChecksum: checksum },
      }),
    ).rejects.toBeInstanceOf(OperatorRunReplayMismatchError);
    expect(await facts(world)).toEqual(untouched);
  },
);

it('refuses a version from another workflow without consuming the request', async () => {
  const world = await requested();
  await ownerQuery(
    'update app.operator_run_replay_requests set workflow_id=$2 where command_id=$1',
    [world.commandId, randomUUID()],
  );
  await expect(
    schedule.replayStore.replay({
      commandId: world.commandId,
      delivery: world.delivery,
      workspaceId,
    }),
  ).rejects.toThrow('Run replay target is not executable');
  expect(await facts(world)).toEqual(untouched);
});

it.each(['checkpoint', 'acceptance', 'completion'] as const)(
  'rolls back all durable replay effects when %s fails',
  async (phase) => {
    const world = await requested();
    const input = {
      commandId: world.commandId,
      delivery: world.delivery,
      workspaceId,
    };
    if (phase === 'checkpoint') {
      const { createOperatorRunReplayStore } =
        await import('../../src/operator/replay/operator-run-replay.store.js');
      const failed = createOperatorRunReplayStore(
        parseDatabaseConfig({ connectionString: schedule.apiConnectionString }),
        () => {
          throw new Error('checkpoint construction refused');
        },
      );
      try {
        await expect(failed.replay(input)).rejects.toThrow(
          'checkpoint construction refused',
        );
      } finally {
        await failed.close();
      }
    } else {
      const table =
        phase === 'acceptance'
          ? 'workflow_runs'
          : 'operator_run_replay_requests';
      const condition =
        phase === 'acceptance'
          ? `replay_command_id is distinct from '${world.commandId}'::uuid`
          : `command_id <> '${world.commandId}'::uuid or status <> 'completed'`;
      await ownerQuery(
        `alter table app.${table} add constraint refuse_replay_effect check (${condition}) not valid`,
      );
      try {
        await expect(schedule.replayStore.replay(input)).rejects.toThrow();
      } finally {
        await ownerQuery(
          `alter table app.${table} drop constraint refuse_replay_effect`,
        );
      }
    }
    expect(await facts(world)).toEqual(untouched);
    await expect(schedule.replayStore.replay(input)).resolves.toMatchObject({
      kind: 'processed',
    });
    expect(await facts(world)).toMatchObject({
      runs: 1,
      receipts: 1,
      request: 'completed',
      command: 'completed',
    });
  },
);

it('cannot retain a replay request naming a version that does not exist', async () => {
  const world = await requested();
  await expect(
    ownerQuery(
      'update app.operator_run_replay_requests set workflow_version_id=$2 where command_id=$1',
      [world.commandId, randomUUID()],
    ),
  ).rejects.toMatchObject({ code: '23503' });
  expect(await facts(world)).toEqual(untouched);
});
