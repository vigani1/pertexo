import { createHash, randomUUID } from 'node:crypto';

import { canonicalJson } from '@pertexo/workflow-model';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OperatorCommandConflictError } from '../../src/operator/contract.js';
import { createScheduleTriggerTestEnvironment } from '../support/schedule-triggers.js';

const schedule = createScheduleTriggerTestEnvironment({
  includeOperator: true,
});
const { ownerQuery, versionId, workerQuery, workflowId, workspaceId } =
  schedule;
let sourceRunId = '';
/** Only the operator's role writes command rows, so a seeded receipt goes in as it. */
let maintenance: Pool;

beforeAll(async () => {
  sourceRunId = await schedule.initialize();
  const url = new URL(
    process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
  );
  url.pathname = new URL(schedule.apiConnectionString).pathname;
  maintenance = new Pool({ connectionString: url.toString(), max: 1 });
});
afterAll(async () => {
  await maintenance.end();
  await schedule.close();
});

const actorRef = 'operator:pin';
const reason = 'pin what the operator pass must not change';
const base = () => ({
  actorRef,
  commandId: randomUUID(),
  reason,
  workspaceId,
});

type AuditRow = Readonly<{
  action: string;
  target_type: string;
  target_id: string;
  request_id: string;
  metadata: Record<string, unknown>;
}>;

async function auditFor(commandId: string) {
  const { rows } = await ownerQuery<AuditRow>(
    `select action,target_type,target_id,request_id,metadata
     from app.audit_events where workspace_id=$1 and request_id=$2
     order by occurred_at,id`,
    [workspaceId, commandId],
  );
  return rows;
}

async function storedCommand(commandId: string) {
  const { rows } = await workerQuery<{ outcome: string; status: string }>(
    'select outcome,status from app.operator_commands where id=$1',
    [commandId],
  );
  return rows[0];
}

/** Each command against a target that isn't there, so none needs a stuck run to exist. */
const COMMANDS = [
  {
    type: 'outbox.redispatch',
    action: 'operator.outbox_redispatch',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.redispatchFailedOutbox({
        ...input,
        dryRun: true,
        outboxEventId: randomUUID(),
      }),
  },
  {
    type: 'attempt.reconcile',
    action: 'operator.attempt_reconcile',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.reconcileAttempt({
        ...input,
        dryRun: true,
        action: 'reclaim',
        attemptId: randomUUID(),
        expectedFenceToken: 1,
      }),
  },
  {
    type: 'due-work.resume',
    action: 'operator.due-work_resume',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.resumeDueWork({
        ...input,
        dryRun: true,
        runId: randomUUID(),
      }),
  },
  {
    type: 'run.cancel',
    action: 'operator.run_cancel',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.cancelRun({
        ...input,
        dryRun: true,
        runId: randomUUID(),
      }),
  },
  {
    type: 'unknown-outcome.record-evidence',
    action: 'operator.unknown-outcome_record-evidence',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.recordUnknownOutcomeEvidence({
        ...input,
        attemptId: randomUUID(),
        evidenceKind: 'provider.receipt',
        evidenceRef: { receipt: 'r-1' },
      }),
  },
  {
    type: 'trigger.reconcile',
    action: 'operator.trigger_reconcile',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.retryTriggerReconciliation({
        ...input,
        dryRun: true,
        workflowId: randomUUID(),
      }),
  },
  {
    type: 'run.replay',
    action: 'operator.run_replay',
    send: (input: ReturnType<typeof base>) =>
      schedule.operator.replayRun({
        ...input,
        dryRun: true,
        runInput: { pinned: true },
        sourceRunId: randomUUID(),
        workflowVersionId: randomUUID(),
      }),
  },
] as const;

describe('every operator command', () => {
  it.each(COMMANDS.map((command) => [command.type, command] as const))(
    '%s writes one audit event with its actor reference and reason',
    async (_type, { action, send }) => {
      const input = base();
      const result = await send(input);
      expect(result).toMatchObject({
        commandId: input.commandId,
        replayed: false,
      });
      expect(await auditFor(input.commandId)).toEqual([
        expect.objectContaining({
          action,
          request_id: input.commandId,
          metadata: expect.objectContaining({
            actorRef,
            reason,
            outcome: result.outcome,
          }) as unknown,
        }),
      ]);
    },
  );

  it.each(COMMANDS.map((command) => [command.type, command] as const))(
    '%s audits a conflicting reuse of its ID and keeps the first outcome',
    async (_type, { send }) => {
      const input = base();
      const first = await send(input);
      // The target is fresh each call, so only the fingerprint separates these.
      await expect(send(input)).rejects.toBeInstanceOf(
        OperatorCommandConflictError,
      );
      expect(await storedCommand(input.commandId)).toEqual({
        outcome: first.outcome,
        status: first.status,
      });
      expect(
        (await auditFor(input.commandId)).map(({ metadata }) => metadata),
      ).toEqual([
        expect.objectContaining({ outcome: first.outcome, actorRef, reason }),
        expect.objectContaining({
          outcome: 'conflict',
          replayed: true,
          actorRef,
          reason,
        }),
      ]);
    },
  );

  it('reading a command is audited with its actor reference and reason', async () => {
    const commandId = randomUUID();
    await expect(
      schedule.operator.getCommand({
        actorRef,
        commandId,
        reason,
        workspaceId,
      }),
    ).resolves.toBeNull();
    const { rows } = await ownerQuery<AuditRow>(
      `select action,target_id,metadata from app.audit_events
       where workspace_id=$1 and target_id=$2`,
      [workspaceId, commandId],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'operator.command_status',
        metadata: expect.objectContaining({
          actorRef,
          reason,
          found: false,
        }) as unknown,
      }),
    ]);
  });
});

describe('a command ID used again', () => {
  const replayInput = () => ({
    ...base(),
    dryRun: false,
    runInput: { attempt: 'first' },
    sourceRunId,
    workflowVersionId: versionId,
  });

  async function replayRequestFacts(commandId: string) {
    const { rows } = await ownerQuery<{ requests: number; outbox: number }>(
      `select
         (select count(*)::int from app.operator_run_replay_requests where command_id=$1) requests,
         (select count(*)::int from app.outbox_events where aggregate_id=$1) outbox`,
      [commandId],
    );
    return rows[0];
  }

  it('returns the stored outcome with replayed: true and does not act twice', async () => {
    const input = replayInput();
    const first = await schedule.operator.replayRun(input);
    expect(first).toMatchObject({
      outcome: 'replay_requested',
      replayed: false,
      status: 'pending',
    });
    await expect(schedule.operator.replayRun(input)).resolves.toEqual({
      ...first,
      replayed: true,
    });
    expect(await replayRequestFacts(input.commandId)).toEqual({
      requests: 1,
      outbox: 1,
    });
    expect(
      (await auditFor(input.commandId)).map(({ metadata }) => metadata),
    ).toEqual([
      expect.objectContaining({
        outcome: 'replay_requested',
        actorRef,
        reason,
      }),
      expect.objectContaining({
        outcome: 'replay_requested',
        replayed: true,
        actorRef,
        reason,
      }),
    ]);
  });

  it('keeps answering with the first outcome after the world has moved on', async () => {
    const replay = await schedule.operator.replayRun(replayInput());
    const outboxEventId = String(replay.result.outboxEventId);
    const failed = (at: number) =>
      ownerQuery(
        `update app.outbox_events
           set failed_at=clock_timestamp(),publish_attempts=$2,last_error_code='transport',
               available_at=clock_timestamp()
         where id=$1`,
        [outboxEventId, at],
      );
    const redeliveries = async () =>
      (
        await ownerQuery<{ redeliveries: number; failed: boolean }>(
          `select redeliveries,failed_at is not null failed from app.outbox_events where id=$1`,
          [outboxEventId],
        )
      ).rows[0];
    await failed(3);
    const input = { ...base(), dryRun: false, outboxEventId };

    const first = await schedule.operator.redispatchFailedOutbox(input);
    expect(first).toMatchObject({
      outcome: 'redispatched',
      replayed: false,
      status: 'completed',
    });
    expect(await redeliveries()).toEqual({ redeliveries: 1, failed: false });

    // Failed again: a second action would redispatch it, the replay must not.
    await failed(4);
    await expect(
      schedule.operator.redispatchFailedOutbox(input),
    ).resolves.toEqual({ ...first, replayed: true });
    expect(await redeliveries()).toEqual({ redeliveries: 1, failed: true });
  });

  it.each([
    ['its reason', { reason: 'another reason' }],
    ['its actor', { actorRef: 'operator:someone-else' }],
    ['dry run', { dryRun: true }],
    ['its input', { runInput: { attempt: 'second' } }],
    ['its source run', { sourceRunId: randomUUID() }],
    ['its version', { workflowVersionId: randomUUID() }],
  ])(
    'throws the conflict error when %s changes, audits the attempt, and does nothing',
    async (_name, change) => {
      const input = replayInput();
      const first = await schedule.operator.replayRun(input);
      const changed = { ...input, ...change };

      await expect(schedule.operator.replayRun(changed)).rejects.toBeInstanceOf(
        OperatorCommandConflictError,
      );

      expect(await replayRequestFacts(input.commandId)).toEqual({
        requests: 1,
        outbox: 1,
      });
      expect(await storedCommand(input.commandId)).toEqual({
        outcome: first.outcome,
        status: 'pending',
      });
      const audited = await auditFor(input.commandId);
      expect(audited).toHaveLength(2);
      expect(audited[1]?.metadata).toMatchObject({
        outcome: 'conflict',
        replayed: true,
        actorRef: changed.actorRef,
        reason: changed.reason,
      });
    },
  );
});

describe('a retry from before the pass', () => {
  const sha256 = (text: string) =>
    createHash('sha256').update(text).digest('hex');

  async function seedReceipt(
    commandId: string,
    type: string,
    dryRun: boolean,
    fingerprint: string,
  ) {
    const client = await maintenance.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.operator_commands(
           id,workspace_id,command_type,dry_run,request_fingerprint,status,outcome,result,completed_at
         ) values($1,$2,$3,$4,$5,'completed','stored_outcome','{"stored":true}'::jsonb,clock_timestamp())`,
        [commandId, workspaceId, type, dryRun, fingerprint],
      );
      await client.query('commit');
    } finally {
      client.release();
    }
  }

  const dryRun = true;
  const attemptId = randomUUID();
  const targetRun = randomUUID();
  const targetOutbox = randomUUID();
  const targetWorkflow = randomUUID();
  const targetVersion = randomUUID();
  const evidenceRef = { receipt: 'r-1' };

  // The request material as it stood before the pass, field by field.
  const RECEIPTS = [
    {
      type: 'outbox.redispatch',
      dryRun,
      material: { outboxEventId: targetOutbox },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.redispatchFailedOutbox({
          ...input,
          dryRun,
          outboxEventId: targetOutbox,
        }),
    },
    {
      type: 'attempt.reconcile',
      dryRun,
      material: { action: 'reclaim', expectedFence: 4, targetId: attemptId },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.reconcileAttempt({
          ...input,
          dryRun,
          action: 'reclaim',
          attemptId,
          expectedFenceToken: 4,
        }),
    },
    {
      type: 'due-work.resume',
      dryRun,
      material: { targetId: targetRun },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.resumeDueWork({
          ...input,
          dryRun,
          runId: targetRun,
        }),
    },
    {
      type: 'run.cancel',
      dryRun,
      material: { targetId: targetRun },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.cancelRun({ ...input, dryRun, runId: targetRun }),
    },
    {
      type: 'unknown-outcome.record-evidence',
      dryRun: false,
      material: {
        evidenceKind: 'provider.receipt',
        evidenceRef,
        targetId: attemptId,
      },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.recordUnknownOutcomeEvidence({
          ...input,
          attemptId,
          evidenceKind: 'provider.receipt',
          evidenceRef,
        }),
    },
    {
      type: 'trigger.reconcile',
      dryRun,
      material: { workflowId: targetWorkflow },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.retryTriggerReconciliation({
          ...input,
          dryRun,
          workflowId: targetWorkflow,
        }),
    },
    {
      type: 'run.replay',
      dryRun,
      material: {
        runInput: { pinned: true },
        sourceRunId: targetRun,
        workflowVersionId: targetVersion,
      },
      send: (input: ReturnType<typeof base>) =>
        schedule.operator.replayRun({
          ...input,
          dryRun,
          runInput: { pinned: true },
          sourceRunId: targetRun,
          workflowVersionId: targetVersion,
        }),
    },
  ] as const;

  it.each(RECEIPTS.map((receipt) => [receipt.type, receipt] as const))(
    '%s still matches its stored receipt and gets the stored outcome',
    async (type, receipt) => {
      const input = base();
      const fingerprint = sha256(
        canonicalJson({
          ...receipt.material,
          actorRef,
          commandType: type,
          dryRun: receipt.dryRun,
          reason,
          workspaceId,
        }),
      );
      await seedReceipt(input.commandId, type, receipt.dryRun, fingerprint);

      await expect(receipt.send(input)).resolves.toMatchObject({
        commandId: input.commandId,
        outcome: 'stored_outcome',
        replayed: true,
        status: 'completed',
      });
    },
  );
});

describe('oversized operator input', () => {
  it('rejects a replay input over 64 KiB as a promise and records nothing', async () => {
    const input = base();
    // A JSON string adds its two quotes.
    const refused = schedule.operator.replayRun({
      ...input,
      dryRun: true,
      runInput: 'a'.repeat(65_535),
      sourceRunId,
      workflowVersionId: versionId,
    });
    expect(refused).toBeInstanceOf(Promise);
    await expect(refused).rejects.toThrow(
      'Operator replay input must not exceed 65536 UTF-8 bytes',
    );
    expect(await storedCommand(input.commandId)).toBeUndefined();
    expect(await auditFor(input.commandId)).toEqual([]);
  });

  it('takes a replay input of exactly 64 KiB', async () => {
    await expect(
      schedule.operator.replayRun({
        ...base(),
        dryRun: true,
        runInput: 'a'.repeat(65_534),
        sourceRunId,
        workflowVersionId: versionId,
      }),
    ).resolves.toMatchObject({ outcome: 'would_request' });
  });

  it('rejects evidence over 4 KiB as a promise and records nothing', async () => {
    const input = base();
    const refused = schedule.operator.recordUnknownOutcomeEvidence({
      ...input,
      attemptId: randomUUID(),
      evidenceKind: 'provider.receipt',
      evidenceRef: { value: 'a'.repeat(4085) },
    });
    expect(refused).toBeInstanceOf(Promise);
    await expect(refused).rejects.toThrow(
      'Unknown outcome evidence must not exceed 4096 UTF-8 bytes',
    );
    expect(await storedCommand(input.commandId)).toBeUndefined();
    expect(await auditFor(input.commandId)).toEqual([]);
  });
});

describe('a real workflow target', () => {
  it('reconciles triggers once for a command ID used twice', async () => {
    const input = { ...base(), dryRun: false, workflowId };
    const outbox = async () =>
      (
        await ownerQuery<{ n: number }>(
          `select count(*)::int n from app.outbox_events
           where aggregate_id=$1 and job_name='reconcile-workflow-triggers'`,
          [workflowId],
        )
      ).rows[0]?.n;
    const before = await outbox();
    const first = await schedule.operator.retryTriggerReconciliation(input);
    expect(first).toMatchObject({ outcome: 'retry_requested' });
    expect(await outbox()).toBe((before ?? 0) + 1);
    await expect(
      schedule.operator.retryTriggerReconciliation(input),
    ).resolves.toEqual({ ...first, replayed: true });
    expect(await outbox()).toBe((before ?? 0) + 1);
  });
});
