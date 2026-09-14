import { createHash } from 'node:crypto';

import { describe, it, expect } from 'vitest';

import { NodeAttemptReconciliationRequiredError } from '../src/testing.js';
import { createOperatorCommandDatabase } from '../src/operator/operator-commands.js';
import {
  UnknownOutcomeReconciliationMismatchError,
  UnknownOutcomeReconciliationStateError,
  createWorkspaceDatabase,
  reconcileUnknownOutcomeEvidence,
} from '../src/testing.js';

import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptStateCorruptError,
  actorId,
  apiBaseUrl,
  asAdmin,
  asOwner,
  asRuntime,
  checkpoint,
  createDueNodeWakeupScanner,
  databaseUrl,
  insertRun,
  nodeAttemptStore,
  parseDatabaseConfig,
  randomUUID,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './coordinator-run-store.fixtures.js';

async function claimDispatchAttempt(
  nodeId: string,
  options: Readonly<{
    explicitEmptyScope?: boolean;
    runInput?: unknown;
    sideEffectClass?: 'safe' | 'idempotent_with_key' | 'unsafe';
    workerId?: string;
  }> = {},
) {
  const runId = await insertRun({
    inputRef: {
      schemaVersion: 1,
      kind: 'inline',
      value: options.runInput ?? { nodeId },
    },
  });
  const invocationKey = `${versionA}|${nodeId}|b:|i:`;
  const committed = await ownedDeliveryStore.commitAdvancePlan({
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
        runStatus: 'running',
        nextEventSequence: 4,
        admittedInvocationKeys: [invocationKey],
        invocations: [
          {
            invocationKey,
            nodeId,
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'run.started',
          occurredAt: '2026-08-21T00:00:00.000Z',
        },
        {
          schemaVersion: 1,
          sequence: 3,
          name: 'node.ready',
          occurredAt: '2026-08-21T00:00:00.000Z',
          invocationKey,
          nodeId,
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        {
          invocationKey,
          nodeId,
          sideEffectClass: options.sideEffectClass ?? 'unsafe',
        },
      ],
      attempts: [
        {
          invocationKey,
          nodeId,
          attemptNumber: 1,
          sideEffectClass: options.sideEffectClass ?? 'unsafe',
        },
      ],
    },
  });
  if (committed.kind !== 'committed')
    throw new Error('dispatch fixture did not commit');
  const admission = committed.admittedAttempts[0];
  if (admission === undefined) throw new Error('dispatch attempt missing');
  const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
    client.query<{ id: string; payload_checksum: string }>(
      `select id,payload_checksum from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='execute-node-attempt'`,
      [workspaceA, admission.attemptId],
    ),
  );
  const delivery = outbox.rows[0];
  if (delivery === undefined) throw new Error('dispatch delivery missing');
  if (options.explicitEmptyScope === true)
    await asAdmin((client) =>
      client.query(
        `update app.node_runs
            set branch_context='{"branchPath":[],"iterationPath":[]}'::jsonb
          where workspace_id=$1 and id=$2`,
        [workspaceA, admission.nodeRunId],
      ),
    );
  const claimed = await nodeAttemptStore.claimDelivery({
    workspaceId: workspaceA,
    runId,
    nodeRunId: admission.nodeRunId,
    attemptId: admission.attemptId,
    delivery: {
      outboxEventId: delivery.id,
      payloadChecksum: delivery.payload_checksum,
    },
    leaseDurationSeconds: 30,
    workerId: options.workerId ?? `dispatch-worker-${nodeId}`,
    signal: new AbortController().signal,
  });
  if (claimed.kind !== 'claimed')
    throw new Error('dispatch attempt was not claimed');
  return claimed.lease;
}

async function seedDispatchConnection(input: {
  connectionId: string;
  providerKey: 'http' | 'slack';
  authType: 'http_headers' | 'slack_bot_token';
  secretVersionId: string;
}) {
  await asOwner(workspaceA, async (client) => {
    await client.query(
      `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,$3,$4,$5,'active',$6,$7)`,
      [
        input.connectionId,
        workspaceA,
        input.providerKey,
        `Dispatch fence ${input.providerKey} ${input.connectionId}`,
        input.authType,
        input.secretVersionId,
        actorId,
      ],
    );
    await client.query(
      `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','a','a',$4,$5,$6)`,
      [
        input.secretVersionId,
        workspaceA,
        input.connectionId,
        'a'.repeat(16),
        'a'.repeat(22),
        actorId,
      ],
    );
  });
}

function dispatchBinding(
  providerKey: 'http' | 'slack',
  connectionId: string,
  secretVersionId: string,
) {
  return `${providerKey}:v1:sha256:${createHash('sha256')
    .update(`${providerKey}\0${connectionId}\0${secretVersionId}`)
    .digest('hex')}`;
}

describe('Coordinator node-attempt persistence invariants', () => {
  it('reconciles durable unknown-outcome evidence exactly once and rejects mismatches and stale state', async () => {
    const workerDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 2,
      }),
    );
    const prepareEvidence = async (suffix: string) => {
      const lease = await claimDispatchAttempt(
        `unknown-evidence-${suffix}-${randomUUID()}`,
      );
      await nodeAttemptStore.markDispatched({
        lease,
        signal: new AbortController().signal,
      });
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: {
            status: 'outcome_unknown',
            safeErrorCode: 'execution.outcome_unknown',
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'committed' });

      const evidenceCommandId = randomUUID();
      await asOwner(workspaceA, (client) =>
        client.query(
          `select * from app.record_operator_unknown_outcome_evidence(
             $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::jsonb,$6::varchar,$7::varchar
           )`,
          [
            evidenceCommandId,
            workspaceA,
            lease.attemptId,
            'provider_receipt',
            JSON.stringify({ reference: `receipt-${suffix}` }),
            'operator:test',
            'verify durable provider evidence',
          ],
        ),
      );
      const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
             where workspace_id=$1 and aggregate_id=$2
               and job_name='reconcile-unknown-outcome'
             order by created_at desc limit 1`,
          [workspaceA, lease.attemptId],
        ),
      );
      const delivery = outbox.rows[0];
      if (delivery === undefined)
        throw new Error('Unknown-outcome reconciliation delivery missing');
      return { delivery, evidenceCommandId, lease };
    };

    try {
      const current = await prepareEvidence('current');
      const input = {
        attemptId: current.lease.attemptId,
        delivery: {
          outboxEventId: current.delivery.id,
          payloadChecksum: current.delivery.payload_checksum,
        },
        evidenceCommandId: current.evidenceCommandId,
        workspaceId: workspaceA,
      };
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, input),
      ).resolves.toEqual({ kind: 'processed' });
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, input),
      ).resolves.toEqual({ kind: 'duplicate' });

      const commandMismatch = await prepareEvidence('command-mismatch');
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, {
          attemptId: commandMismatch.lease.attemptId,
          delivery: {
            outboxEventId: commandMismatch.delivery.id,
            payloadChecksum: commandMismatch.delivery.payload_checksum,
          },
          evidenceCommandId: randomUUID(),
          workspaceId: workspaceA,
        }),
      ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);

      const checksumMismatch = await prepareEvidence('checksum-mismatch');
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, {
          attemptId: checksumMismatch.lease.attemptId,
          delivery: {
            outboxEventId: checksumMismatch.delivery.id,
            payloadChecksum: 'f'.repeat(64),
          },
          evidenceCommandId: checksumMismatch.evidenceCommandId,
          workspaceId: workspaceA,
        }),
      ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationMismatchError);

      const mismatchReceipts = await asRuntime(
        workerBaseUrl,
        workspaceA,
        (client) =>
          client.query<{ completed: number; message_id: string }>(
            `select message_id,count(completed_at)::int completed
               from app.inbox_receipts
              where workspace_id=$1 and consumer_name='unknown-outcome-reconciler'
                and message_id=any($2::uuid[])
              group by message_id`,
            [
              workspaceA,
              [commandMismatch.delivery.id, checksumMismatch.delivery.id],
            ],
          ),
      );
      expect(mismatchReceipts.rows).toEqual([]);

      const stale = await prepareEvidence('stale');
      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.node_attempts set status='succeeded'
             where workspace_id=$1 and id=$2`,
          [workspaceA, stale.lease.attemptId],
        ),
      );
      await expect(
        reconcileUnknownOutcomeEvidence(workerDatabase, {
          attemptId: stale.lease.attemptId,
          delivery: {
            outboxEventId: stale.delivery.id,
            payloadChecksum: stale.delivery.payload_checksum,
          },
          evidenceCommandId: stale.evidenceCommandId,
          workspaceId: workspaceA,
        }),
      ).rejects.toBeInstanceOf(UnknownOutcomeReconciliationStateError);

      const receipts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ attempt_status: string; completed: number }>(
          `select count(completed_at)::int completed,
              (select status from app.node_attempts
                where workspace_id=$1 and id=$3) attempt_status
               from app.inbox_receipts
              where workspace_id=$1 and consumer_name='unknown-outcome-reconciler'
                and message_id=$2`,
          [workspaceA, stale.delivery.id, stale.lease.attemptId],
        ),
      );
      expect(receipts.rows).toEqual([
        { attempt_status: 'succeeded', completed: 0 },
      ]);
    } finally {
      await workerDatabase.close();
    }
  });

  it('rejects completion when only the durable attempt fence is stale', async () => {
    const lease = await claimDispatchAttempt(
      `stale-completion-${randomUUID()}`,
    );
    await asAdmin((client) =>
      client.query(
        `update app.node_attempts
            set fence_token=fence_token+1
          where workspace_id=$1 and id=$2`,
        [workspaceA, lease.attemptId],
      ),
    );

    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome: { status: 'succeeded', output: { accepted: false } },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptReconciliationRequiredError);

    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          completed_at: Date | null;
          fence_token: string;
          status: string;
        }>(
          `select status,fence_token::text,completed_at
             from app.node_attempts
            where workspace_id=$1 and id=$2`,
          [workspaceA, lease.attemptId],
        ),
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          completed_at: null,
          fence_token: String(lease.fenceToken + 1),
          status: 'running',
        },
      ],
    });
  });

  it('rejects independently stale lease ownership without terminal side effects', async () => {
    for (const mutation of [
      {
        name: 'expired lease',
        sql: `update app.node_attempts
              set lease_expires_at=clock_timestamp()-interval '1 second'
              where workspace_id=$1 and id=$2`,
      },
      {
        name: 'changed owner',
        sql: `update app.node_attempts set lease_owner='replacement-worker'
              where workspace_id=$1 and id=$2`,
      },
      {
        name: 'wrong current attempt',
        sql: `update app.node_runs
              set current_attempt_id=null,current_attempt_number=null
              where workspace_id=$1 and current_attempt_id=$2`,
      },
    ]) {
      const lease = await claimDispatchAttempt(
        `stale-${mutation.name.replaceAll(' ', '-')}-${randomUUID()}`,
      );
      await asAdmin((client) =>
        client.query(mutation.sql, [workspaceA, lease.attemptId]),
      );

      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: { status: 'succeeded', output: { accepted: false } },
          signal: new AbortController().signal,
        }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof NodeAttemptReconciliationRequiredError ||
          error instanceof NodeAttemptStateCorruptError,
      );

      const state = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          attempt_output: unknown;
          attempt_status: string;
          completed_receipts: number;
          continuation_outbox: number;
          node_output: unknown;
          terminal_events: number;
        }>(
          `select attempt.status attempt_status,
                    attempt.output_ref attempt_output,
                    node.output_ref node_output,
                    (select count(*)::int from app.run_events
                      where workspace_id=$1 and workflow_run_id=$3
                        and type in (
                          'node.succeeded','node.failed','node.canceled',
                          'node.timed_out','node.outcome_unknown'
                        )) terminal_events,
                    (select count(*)::int from app.outbox_events
                      where workspace_id=$1 and aggregate_id=$3
                        and job_name='advance-workflow-run') continuation_outbox,
                    (select count(*)::int from app.inbox_receipts
                      where workspace_id=$1 and message_id=$4
                        and completed_at is not null) completed_receipts
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceA,
            lease.attemptId,
            lease.runId,
            lease.delivery.outboxEventId,
          ],
        ),
      );
      expect(state.rows).toEqual([
        {
          attempt_output: null,
          attempt_status: 'running',
          completed_receipts: 0,
          continuation_outbox: 1,
          node_output: null,
          terminal_events: 0,
        },
      ]);
    }
  });

  it('rolls back the full completion transaction after attempt update and after outbox insert', async () => {
    const completionState = (
      lease: Awaited<ReturnType<typeof claimDispatchAttempt>>,
    ) =>
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          advance_outbox: number;
          attempt_output: unknown;
          attempt_status: string;
          completed_receipts: number;
          node_output: unknown;
          node_status: string;
          terminal_events: number;
        }>(
          `select attempt.status attempt_status,
                  attempt.output_ref attempt_output,
                  node.status node_status,node.output_ref node_output,
                  (select count(*)::int from app.run_events
                    where workspace_id=$1 and workflow_run_id=$3
                      and type='node.succeeded') terminal_events,
                  (select count(*)::int from app.outbox_events
                    where workspace_id=$1 and aggregate_id=$3
                      and job_name='advance-workflow-run') advance_outbox,
                  (select count(*)::int from app.inbox_receipts
                    where workspace_id=$1 and message_id=$4
                      and completed_at is not null) completed_receipts
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id
              and node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [
            workspaceA,
            lease.attemptId,
            lease.runId,
            lease.delivery.outboxEventId,
          ],
        ),
      );

    for (const boundary of ['attempt_update', 'outbox_insert'] as const) {
      const lease = await claimDispatchAttempt(
        `completion-rollback-${boundary}-${randomUUID()}`,
      );
      const before = await completionState(lease);
      const functionName = `q35_fail_${boundary}`;
      const triggerName = `q35_fail_${boundary}`;
      const triggerTable =
        boundary === 'attempt_update' ? 'node_attempts' : 'inbox_receipts';
      const triggerColumn =
        boundary === 'attempt_update' ? 'status' : 'completed_at';
      const triggerPredicate =
        boundary === 'attempt_update'
          ? `NEW.id='${lease.attemptId}'::uuid and NEW.status='succeeded'`
          : `NEW.message_id='${lease.delivery.outboxEventId}'::uuid and NEW.completed_at is not null`;
      try {
        await asAdmin(async (client) => {
          await client.query(
            `create function app.${functionName}() returns trigger
               language plpgsql as $$
               begin
                 raise exception 'q35 injected ${boundary} failure';
               end
               $$`,
          );
          await client.query(
            `create trigger ${triggerName}
               after update of ${triggerColumn} on app.${triggerTable}
               for each row when (${triggerPredicate})
               execute function app.${functionName}()`,
          );
        });

        await expect(
          nodeAttemptStore.complete({
            lease,
            outcome: { status: 'succeeded', output: { boundary } },
            signal: new AbortController().signal,
          }),
        ).rejects.toThrow(`q35 injected ${boundary} failure`);
      } finally {
        await asAdmin(async (client) => {
          await client.query(
            `drop trigger if exists ${triggerName} on app.${triggerTable}`,
          );
          await client.query(`drop function if exists app.${functionName}()`);
        });
      }

      const after = await completionState(lease);
      expect(after.rows).toEqual(before.rows);
      expect(after.rows).toEqual([
        {
          advance_outbox: 1,
          attempt_output: null,
          attempt_status: 'running',
          completed_receipts: 0,
          node_output: null,
          node_status: 'running',
          terminal_events: 0,
        },
      ]);
    }
  });

  it('requires exact safe error code and summary for ordinary failure replay', async () => {
    const lease = await claimDispatchAttempt(`failure-replay-${randomUUID()}`);
    const outcome = {
      errorSummary: 'provider rejected the request',
      safeErrorCode: 'node.provider_rejected',
      status: 'failed',
    } as const;
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    for (const changed of [
      { ...outcome, safeErrorCode: 'node.changed_error' },
      { ...outcome, errorSummary: 'changed summary' },
    ])
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: changed,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);

    const effects = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        completed_receipts: number;
        continuation_outbox: number;
        error_summary: string;
        safe_error_code: string;
      }>(
        `select attempt.safe_error_code,attempt.error_summary,
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=$3
                 and job_name='advance-workflow-run') continuation_outbox,
             (select count(*)::int from app.inbox_receipts
               where workspace_id=$1 and message_id=$4
                 and completed_at is not null) completed_receipts
           from app.node_attempts attempt
          where attempt.workspace_id=$1 and attempt.id=$2`,
        [
          workspaceA,
          lease.attemptId,
          lease.runId,
          lease.delivery.outboxEventId,
        ],
      ),
    );
    expect(effects.rows).toEqual([
      {
        completed_receipts: 1,
        continuation_outbox: 2,
        error_summary: outcome.errorSummary,
        safe_error_code: outcome.safeErrorCode,
      },
    ]);
  });

  it('matches executor-failure replay fields before and after coordinator decision', async () => {
    const lease = await claimDispatchAttempt(`executor-replay-${randomUUID()}`);
    const outcome = {
      errorKind: 'network',
      failureKind: 'retry',
      possiblyDispatched: true,
      safeErrorCode: 'node.provider_unavailable',
      status: 'executor_failure',
    } as const;
    const first = await nodeAttemptStore.complete({
      lease,
      outcome,
      signal: new AbortController().signal,
    });
    expect(first.kind).toBe('committed');
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    for (const changed of [
      { ...outcome, failureKind: 'failed' as const },
      { ...outcome, errorKind: 'timeout' as const },
      { ...outcome, possiblyDispatched: false },
      { ...outcome, safeErrorCode: 'node.changed_error' },
    ])
      await expect(
        nodeAttemptStore.complete({
          lease,
          outcome: changed,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);

    await asAdmin((client) =>
      client.query(
        `with finalized as (
           update app.node_attempts set retry_decision='failed'
            where workspace_id=$1 and id=$2 returning node_run_id
         )
         update app.node_runs node
            set status='failed',safe_error_code=$3,
                completed_at=clock_timestamp()
           from finalized
          where node.workspace_id=$1 and node.id=finalized.node_run_id`,
        [workspaceA, lease.attemptId, outcome.safeErrorCode],
      ),
    );
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });

    const effects = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ completed_receipts: number; continuation_outbox: number }>(
        `select
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run') continuation_outbox,
             (select count(*)::int from app.inbox_receipts
               where workspace_id=$1 and message_id=$3
                 and completed_at is not null) completed_receipts`,
        [workspaceA, lease.runId, lease.delivery.outboxEventId],
      ),
    );
    expect(effects.rows).toEqual([
      { completed_receipts: 1, continuation_outbox: 2 },
    ]);
  });

  it('claims one transport-bound ready attempt with a durable fence', async () => {
    const lease = await claimDispatchAttempt('manual', {
      runInput: { hello: 'world' },
      sideEffectClass: 'safe',
      workerId: 'attempt-worker-1',
    });
    expect(lease).toMatchObject({
      attemptNumber: 1,
      fenceToken: 1,
      invocationKey: `${versionA}|manual|b:|i:`,
      nodeId: 'manual',
      sideEffectClass: 'safe',
      workerId: 'attempt-worker-1',
      workflowVersionId: versionA,
    });
    expect(lease).not.toHaveProperty('branchPath');
    expect(lease).not.toHaveProperty('iterationPath');
    expect(lease.providerDispatchUnresolved).toBeUndefined();
    const explicitEmptyLease = await claimDispatchAttempt(
      'manual-empty-scope',
      {
        explicitEmptyScope: true,
        sideEffectClass: 'safe',
      },
    );
    expect(explicitEmptyLease).not.toHaveProperty('branchPath');
    expect(explicitEmptyLease).not.toHaveProperty('iterationPath');
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId: lease.runId,
        nodeRunId: lease.nodeRunId,
        attemptId: lease.attemptId,
        delivery: lease.delivery,
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-2',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      nodeAttemptStore.loadInputs({
        lease,
        upstreamNodeOutputs: [],
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      abortRequested: false,
      completedNodeOutputs: [],
      runInput: { hello: 'world' },
    });
  });

  it('keeps connection binding and dispatch ownership atomic', async () => {
    const claimed = {
      kind: 'claimed' as const,
      lease: await claimDispatchAttempt('manual-connection-fence', {
        sideEffectClass: 'safe',
        workerId: 'attempt-worker-connection',
      }),
    };
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const nextSecretVersionId = randomUUID();
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connections (
             id,workspace_id,provider_key,name,auth_type,status,
             current_secret_version_id,created_by
           ) values ($1,$2,'email',$3,'resend_api_key','active',$4,$5)`,
        [
          connectionId,
          workspaceA,
          `Dispatch fence ${connectionId}`,
          secretVersionId,
          actorId,
        ],
      );
      await client.query(
        `insert into app.connection_secret_versions (
             id,workspace_id,connection_id,schema_version,kms_key_reference,
             encrypted_data_key,ciphertext,nonce,auth_tag,created_by
           ) values ($1,$2,$3,1,'kms','a','a',$4,$5,$6)`,
        [
          secretVersionId,
          workspaceA,
          connectionId,
          'a'.repeat(16),
          'a'.repeat(22),
          actorId,
        ],
      );
    });
    const connectionFence = {
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      secretVersionId,
    } as const;
    const providerDispatchBinding = 'email:v1:sha256:' + 'a'.repeat(64);
    await asAdmin((client) =>
      client.query(`update app.workspaces set status='suspended' where id=$1`, [
        workspaceA,
      ]),
    );
    try {
      await expect(
        nodeAttemptStore.markDispatched({
          lease: claimed.lease,
          connectionFence,
          providerDispatchBinding,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    } finally {
      await asAdmin((client) =>
        client.query(`update app.workspaces set status='active' where id=$1`, [
          workspaceA,
        ]),
      );
    }
    await expect(
      asAdmin(async (client) => {
        const evidence = await client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select attempt.dispatch_marked_at,node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, claimed.lease.attemptId],
        );
        return evidence.rows[0];
      }),
    ).resolves.toEqual({
      dispatch_marked_at: null,
      provider_dispatch_binding: null,
    });
    const dispatched = await nodeAttemptStore.markDispatched({
      lease: claimed.lease,
      connectionFence,
      providerDispatchBinding,
      signal: new AbortController().signal,
    });
    expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
    expect(claimed.lease.providerDispatchUnresolved).toBeUndefined();
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(dispatched);
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        providerDispatchBinding: 'email:v1:sha256:' + 'b'.repeat(64),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDispatchBindingMismatchError);
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connection_secret_versions (
             id,workspace_id,connection_id,schema_version,kms_key_reference,
             encrypted_data_key,ciphertext,nonce,auth_tag,created_by
           ) values ($1,$2,$3,1,'kms','b','b',$4,$5,$6)`,
        [
          nextSecretVersionId,
          workspaceA,
          connectionId,
          'b'.repeat(16),
          'b'.repeat(22),
          actorId,
        ],
      );
      await client.query(
        `update app.connections set current_secret_version_id=$3
           where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId, nextSecretVersionId],
      );
    });
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.connections
           set current_secret_version_id=$3,status='revoked'
           where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId, secretVersionId],
      ),
    );
    await expect(
      nodeAttemptStore.markDispatched({
        lease: claimed.lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
    const heartbeat = await nodeAttemptStore.heartbeat({
      lease: claimed.lease,
      leaseDurationSeconds: 30,
      signal: new AbortController().signal,
    });
    expect(heartbeat.abortRequested).toBe(false);
    expect(heartbeat.leaseExpiresAt).toBeInstanceOf(Date);
  });

  it('commits and replays one exact terminal value and audits a mismatched delivery once', async () => {
    const lease = await claimDispatchAttempt('manual-completion', {
      sideEffectClass: 'safe',
      workerId: 'attempt-worker-completion',
    });
    const claimed = { kind: 'claimed' as const, lease };
    const runId = lease.runId;
    const admission = {
      attemptId: lease.attemptId,
      nodeRunId: lease.nodeRunId,
    };
    const delivery = {
      id: lease.delivery.outboxEventId,
      payload_checksum: lease.delivery.payloadChecksum,
    };
    const providerDispatchBinding = 'email:v1:sha256:' + 'a'.repeat(64);
    await nodeAttemptStore.markDispatched({
      lease,
      providerDispatchBinding,
      signal: new AbortController().signal,
    });
    const httpArtifactOutput = {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: {
        kind: 'artifact',
        artifactId: randomUUID(),
        byteLength: 70_000,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      },
      finalOrigin: 'https://provider.example.test',
      redirectCount: 0,
    };
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/octet-stream',70000,$4,
             'available',now()+interval '1 day',now())`,
        [
          httpArtifactOutput.body.artifactId,
          workspaceA,
          `workspaces/${workspaceA}/artifacts/${httpArtifactOutput.body.artifactId}`,
          httpArtifactOutput.body.sha256,
        ],
      ),
    );
    const completed = await nodeAttemptStore.complete({
      lease: claimed.lease,
      outcome: { status: 'succeeded', output: httpArtifactOutput },
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      signal: new AbortController().signal,
    });
    if (completed.kind !== 'committed')
      throw new Error('attempt completion did not commit');
    expect(completed.outboxEventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        attempt_status: string;
        node_status: string;
        output_matches: boolean;
        terminal_events: number;
        provider_dispatch_binding: string | null;
        continuation_outbox: number;
        completed_receipts: number;
      }>(
        `select
             attempt.status attempt_status,node.status node_status,
             node.provider_dispatch_binding,
             attempt.output_ref=node.output_ref output_matches,
             (select count(*)::int from app.run_events
               where workflow_run_id=$1 and type='node.succeeded') terminal_events,
             (select count(*)::int from app.outbox_events
               where aggregate_id=$1 and job_name='advance-workflow-run'
                 and id=$5) continuation_outbox,
             (select count(*)::int from app.inbox_receipts
               where message_id=$4 and completed_at is not null) completed_receipts
           from app.node_attempts attempt
           join app.node_runs node on node.id=attempt.node_run_id
           where attempt.workspace_id=$2 and attempt.id=$3`,
        [
          runId,
          workspaceA,
          admission.attemptId,
          delivery.id,
          completed.outboxEventId,
        ],
      ),
    );
    expect(terminal.rows[0]).toEqual({
      attempt_status: 'succeeded',
      provider_dispatch_binding: providerDispatchBinding,
      node_status: 'succeeded',
      output_matches: true,
      terminal_events: 1,
      continuation_outbox: 1,
      completed_receipts: 1,
    });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: { status: 'succeeded', output: httpArtifactOutput },
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate', outboxEventId: null });
    await expect(
      nodeAttemptStore.complete({
        lease: claimed.lease,
        outcome: { status: 'succeeded', output: { hello: 'changed' } },
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptStateCorruptError);
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-1',
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId: randomUUID(),
        nodeRunId: admission.nodeRunId,
        attemptId: admission.attemptId,
        delivery: {
          outboxEventId: delivery.id,
          payloadChecksum: delivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDeliveryMismatchError);
    await expect(
      asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ count: number }>(
          `select count(*)::int count
             from app.transport_security_audit_facts
             where workspace_id=$1 and consumer_name='node-attempt-worker'
               and message_id=$2`,
          [workspaceA, delivery.id],
        ),
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it('loads the immutable persisted upstream value for an independent downstream attempt', async () => {
    const lease = await claimDispatchAttempt('manual-upstream', {
      sideEffectClass: 'safe',
      workerId: 'attempt-worker-upstream',
    });
    const runId = lease.runId;
    const invocationKey = lease.invocationKey;
    const admission = {
      attemptId: lease.attemptId,
      nodeRunId: lease.nodeRunId,
    };
    const httpArtifactOutput = {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      body: {
        kind: 'artifact',
        artifactId: randomUUID(),
        byteLength: 70_000,
        mediaType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
      },
      finalOrigin: 'https://provider.example.test',
      redirectCount: 0,
    };
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `insert into app.artifacts (
             id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at
           ) values ($1,$2,'node-output',$3,'application/octet-stream',70000,$4,
             'available',now()+interval '1 day',now())`,
        [
          httpArtifactOutput.body.artifactId,
          workspaceA,
          `workspaces/${workspaceA}/artifacts/${httpArtifactOutput.body.artifactId}`,
          httpArtifactOutput.body.sha256,
        ],
      ),
    );
    await expect(
      nodeAttemptStore.complete({
        lease,
        outcome: { status: 'succeeded', output: httpArtifactOutput },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    const persistedArtifactId = httpArtifactOutput.body.artifactId;
    httpArtifactOutput.body.artifactId = randomUUID();
    const downstreamInvocationKey = `${versionA}|downstream|b:|i:`;
    const downstreamCommitted = await ownedDeliveryStore.commitAdvancePlan({
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
          runStatus: 'running',
          nextEventSequence: 7,
          admittedInvocationKeys: [invocationKey, downstreamInvocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'manual-upstream',
              status: 'succeeded',
              attemptNumber: 1,
              output: { kind: 'inline', attemptId: admission.attemptId },
            },
            {
              invocationKey: downstreamInvocationKey,
              nodeId: 'downstream',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 6,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:01.000Z',
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          {
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            sideEffectClass: 'safe',
          },
        ],
        attempts: [
          {
            invocationKey: downstreamInvocationKey,
            nodeId: 'downstream',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (downstreamCommitted.kind !== 'committed')
      throw new Error(
        `downstream fixture did not commit: ${JSON.stringify(downstreamCommitted)}`,
      );
    const downstreamAdmission = downstreamCommitted.admittedAttempts[0];
    if (downstreamAdmission === undefined)
      throw new Error('downstream attempt is missing');
    const downstreamOutbox = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{ id: string; payload_checksum: string }>(
          `select id,payload_checksum from app.outbox_events
             where workspace_id=$1 and aggregate_id=$2
               and job_name='execute-node-attempt'`,
          [workspaceA, downstreamAdmission.attemptId],
        ),
    );
    const downstreamDelivery = downstreamOutbox.rows[0];
    if (downstreamDelivery === undefined)
      throw new Error('downstream delivery is missing');
    const downstreamClaim = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: downstreamAdmission.nodeRunId,
      attemptId: downstreamAdmission.attemptId,
      delivery: {
        outboxEventId: downstreamDelivery.id,
        payloadChecksum: downstreamDelivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-2',
      signal: new AbortController().signal,
    });
    if (downstreamClaim.kind !== 'claimed')
      throw new Error('downstream attempt was not claimed');
    await expect(
      nodeAttemptStore.loadInputs({
        lease: downstreamClaim.lease,
        upstreamNodeOutputs: [{ nodeId: 'manual-upstream', invocationKey }],
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      completedNodeOutputs: [
        {
          nodeId: 'manual-upstream',
          invocationKey,
          value: {
            status: 200,
            body: {
              kind: 'artifact',
              artifactId: persistedArtifactId,
              byteLength: 70_000,
              mediaType: 'application/octet-stream',
              sha256: 'a'.repeat(64),
            },
          },
        },
      ],
    });
  });

  it('keeps HTTP and Slack dispatch markers fenced across credential rotation', async () => {
    for (const target of [
      { providerKey: 'http', authType: 'http_headers' },
      { providerKey: 'slack', authType: 'slack_bot_token' },
    ] as const) {
      const lease = await claimDispatchAttempt(
        `dispatch-${target.providerKey}`,
      );
      const connectionId = randomUUID();
      const secretVersionId = randomUUID();
      const rotatedSecretVersionId = randomUUID();
      await seedDispatchConnection({
        connectionId,
        providerKey: target.providerKey,
        authType: target.authType,
        secretVersionId,
      });
      const connectionFence = {
        connectionId,
        expectedProviderKey: target.providerKey,
        expectedAuthType: target.authType,
        secretVersionId,
      } as const;
      const providerDispatchBinding = dispatchBinding(
        target.providerKey,
        connectionId,
        secretVersionId,
      );
      const preflight = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ fence_current: boolean }>(
          `select app.connection_dispatch_fence_current($1,$2,$3,$4,$5)
             fence_current`,
          [
            workspaceA,
            connectionId,
            target.providerKey,
            target.authType,
            secretVersionId,
          ],
        ),
      );
      expect(preflight.rows[0]?.fence_current).toBe(true);

      await asOwner(workspaceA, async (client) => {
        await client.query(
          `insert into app.connection_secret_versions (
               id,workspace_id,connection_id,schema_version,kms_key_reference,
               encrypted_data_key,ciphertext,nonce,auth_tag,created_by
             ) values ($1,$2,$3,1,'kms','b','b',$4,$5,$6)`,
          [
            rotatedSecretVersionId,
            workspaceA,
            connectionId,
            'b'.repeat(16),
            'b'.repeat(22),
            actorId,
          ],
        );
        await client.query(
          `update app.connections set current_secret_version_id=$3
             where workspace_id=$1 and id=$2`,
          [workspaceA, connectionId, rotatedSecretVersionId],
        );
      });

      await expect(
        nodeAttemptStore.markDispatched({
          lease,
          connectionFence,
          providerDispatchBinding,
          signal: new AbortController().signal,
        }),
      ).rejects.toBeInstanceOf(NodeAttemptConnectionFenceError);
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            dispatch_marked_at: Date | null;
            provider_dispatch_binding: string | null;
          }>(
            `select attempt.dispatch_marked_at,node.provider_dispatch_binding
               from app.node_attempts attempt
               join app.node_runs node on node.id=attempt.node_run_id
              where attempt.workspace_id=$1 and attempt.id=$2`,
            [workspaceA, lease.attemptId],
          ),
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            dispatch_marked_at: null,
            provider_dispatch_binding: null,
          },
        ],
      });

      await asOwner(workspaceA, (client) =>
        client.query(
          `update app.connections set current_secret_version_id=$3
             where workspace_id=$1 and id=$2`,
          [workspaceA, connectionId, secretVersionId],
        ),
      );
      const dispatched = await nodeAttemptStore.markDispatched({
        lease,
        connectionFence,
        providerDispatchBinding,
        signal: new AbortController().signal,
      });
      expect(dispatched.dispatchedAt).toBeInstanceOf(Date);
      const verified = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select attempt.dispatch_marked_at,node.provider_dispatch_binding
             from app.node_attempts attempt
             join app.node_runs node on node.id=attempt.node_run_id
            where attempt.workspace_id=$1 and attempt.id=$2`,
          [workspaceA, lease.attemptId],
        ),
      );
      expect(verified.rows).toHaveLength(1);
      expect(verified.rows[0]?.dispatch_marked_at).toBeInstanceOf(Date);
      expect(verified.rows[0]?.provider_dispatch_binding).toBe(
        providerDispatchBinding,
      );
    }
  }, 30_000);

  it('atomically suspends an attempt from database time without an early wakeup', async () => {
    const runId = await insertRun({
      inputRef: { schemaVersion: 1, kind: 'inline', value: { held: true } },
    });
    const invocationKey = `${versionA}|wait|b:|i:`;
    const committed = await ownedDeliveryStore.commitAdvancePlan({
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
          runStatus: 'running',
          nextEventSequence: 4,
          admittedInvocationKeys: [invocationKey],
          invocations: [
            {
              invocationKey,
              nodeId: 'wait',
              status: 'running',
              attemptNumber: 1,
            },
          ],
        }),
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            name: 'run.started',
            occurredAt: '2026-08-21T00:00:00.000Z',
          },
          {
            schemaVersion: 1,
            sequence: 3,
            name: 'node.ready',
            occurredAt: '2026-08-21T00:00:00.000Z',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 0,
          },
        ],
        nodeRunAdmissions: [
          { invocationKey, nodeId: 'wait', sideEffectClass: 'safe' },
        ],
        attempts: [
          {
            admissionKind: 'execute',
            invocationKey,
            nodeId: 'wait',
            attemptNumber: 1,
            sideEffectClass: 'safe',
          },
        ],
      },
    });
    if (committed.kind !== 'committed')
      throw new Error('fixture did not commit');
    const admission = committed.admittedAttempts[0];
    if (admission === undefined) throw new Error('fixture attempt missing');
    const outbox = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2 and job_name='execute-node-attempt'`,
        [workspaceA, admission.attemptId],
      ),
    );
    const delivery = outbox.rows[0];
    if (delivery === undefined) throw new Error('fixture delivery missing');
    const claimed = await nodeAttemptStore.claimDelivery({
      workspaceId: workspaceA,
      runId,
      nodeRunId: admission.nodeRunId,
      attemptId: admission.attemptId,
      delivery: {
        outboxEventId: delivery.id,
        payloadChecksum: delivery.payload_checksum,
      },
      leaseDurationSeconds: 30,
      workerId: 'attempt-worker-wait',
      signal: new AbortController().signal,
    });
    if (claimed.kind !== 'claimed') throw new Error('attempt was not claimed');

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
        workerRuntimeRole: 'pertexo_worker',
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
              schemaVersion: 1,
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
        workerRuntimeRole: 'pertexo_worker',
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
            schemaVersion: 1,
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
      abortRequested: false,
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

  it('enforces current-head execution command roles and fence dry-run behavior', async () => {
    const operatorBaseUrl =
      process.env.DATABASE_OPERATOR_URL ??
      'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo';
    const operator = createOperatorCommandDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(operatorBaseUrl),
        max: 1,
      }),
    );
    try {
      await expect(operator.checkReadiness()).resolves.toBeUndefined();
      for (const roleUrl of [apiBaseUrl, workerBaseUrl]) {
        await expect(
          asRuntime(roleUrl, workspaceA, (client) =>
            client.query(
              `select * from app.cancel_operator_run(
                 $1::uuid,$2::uuid,$3::uuid,$4::varchar,$5::varchar,$6::boolean
               )`,
              [
                randomUUID(),
                workspaceA,
                randomUUID(),
                'role:test',
                'current-head denial',
                true,
              ],
            ),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }

      const lease = await claimDispatchAttempt(
        `operator-fence-${randomUUID()}`,
      );
      const commandId = randomUUID();
      const command = {
        action: 'reclaim' as const,
        actorRef: 'operator:test',
        attemptId: lease.attemptId,
        commandId,
        dryRun: true,
        expectedFenceToken: lease.fenceToken + 1,
        reason: 'inspect stale attempt fence',
        workspaceId: workspaceA,
      };
      const first = await operator.reconcileAttempt(command);
      expect(first).toMatchObject({
        outcome: 'fence_conflict',
        replayed: false,
        result: { fenceToken: lease.fenceToken + 1 },
      });
      await expect(operator.reconcileAttempt(command)).resolves.toEqual({
        ...first,
        replayed: true,
      });
      await expect(
        operator.reconcileAttempt({
          ...command,
          reason: 'conflicting attempt reason',
        }),
      ).rejects.toThrow('conflicts');

      const facts = await asOwner(workspaceA, (client) =>
        client.query<{
          audit_count: number;
          command_count: number;
          fence_token: string;
          status: string;
        }>(
          `select attempt.status,attempt.fence_token::text,
              (select count(*)::int from app.operator_commands where id=$2)
                command_count,
              (select count(*)::int from app.audit_events
                where workspace_id=$1 and request_id=$2::text)
                audit_count
           from app.node_attempts attempt
           where attempt.workspace_id=$1 and attempt.id=$3`,
          [workspaceA, commandId, lease.attemptId],
        ),
      );
      expect(facts.rows[0]).toEqual({
        audit_count: 3,
        command_count: 1,
        fence_token: String(lease.fenceToken),
        status: 'running',
      });
    } finally {
      await operator.close();
    }
  });

  it('preserves exact 100/101 due-work boundaries and dry-run nonmutation', async () => {
    const operatorBaseUrl =
      process.env.DATABASE_OPERATOR_URL ??
      'postgresql://pertexo_operator:pertexo-local-operator@localhost:5432/pertexo';
    const operator = createOperatorCommandDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(operatorBaseUrl),
        max: 1,
      }),
    );
    const seedDueRun = async (count: number): Promise<string> => {
      const runId = await insertRun({ status: 'running' });
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.node_runs(
             id,workspace_id,workflow_run_id,node_id,invocation_key,
             branch_context,status,side_effect_class,retry_due_at,wait_kind
           )
           select gen_random_uuid(),$1,$2,'operator-due-'||item::text,
             $3||'|operator-due-'||item::text||'|b:|i:',
             '{}'::jsonb,'waiting','safe',
             clock_timestamp()-interval '1 minute','retry_backoff'
           from generate_series(1,$4::integer) item`,
          [workspaceA, runId, versionA, count],
        ),
      );
      return runId;
    };
    try {
      const hundredRunId = await seedDueRun(100);
      const hundredOneRunId = await seedDueRun(101);
      const inspect = async (runId: string) => {
        const command = {
          actorRef: 'operator:test',
          commandId: randomUUID(),
          dryRun: true,
          reason: 'inspect bounded due work',
          runId,
          workspaceId: workspaceA,
        };
        const result = await operator.resumeDueWork(command);
        await expect(operator.resumeDueWork(command)).resolves.toEqual({
          ...result,
          replayed: true,
        });
        return result;
      };

      await expect(inspect(hundredRunId)).resolves.toMatchObject({
        outcome: 'would_resume',
        result: { dueNodeCount: 100, dueNodesRemaining: false },
      });
      await expect(inspect(hundredOneRunId)).resolves.toMatchObject({
        outcome: 'would_resume',
        result: { dueNodeCount: 100, dueNodesRemaining: true },
      });
      const before = await asOwner(workspaceA, (client) =>
        client.query<{ awakened: number; outbox: number }>(
          `select
             (select count(*)::int from app.node_runs
               where workspace_id=$1 and workflow_run_id=any($2::uuid[])
                 and due_wakeup_at is not null) awakened,
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=any($2::uuid[])
                 and job_name='advance-workflow-run') outbox`,
          [workspaceA, [hundredRunId, hundredOneRunId]],
        ),
      );
      expect(before.rows).toEqual([{ awakened: 0, outbox: 0 }]);

      const firstResume = await operator.resumeDueWork({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        dryRun: false,
        reason: 'resume first bounded due page',
        runId: hundredOneRunId,
        workspaceId: workspaceA,
      });
      expect(firstResume).toMatchObject({
        outcome: 'resumed',
        result: { dueNodeCount: 100, dueNodesRemaining: true },
      });
      const secondResume = await operator.resumeDueWork({
        actorRef: 'operator:test',
        commandId: randomUUID(),
        dryRun: false,
        reason: 'resume final bounded due page',
        runId: hundredOneRunId,
        workspaceId: workspaceA,
      });
      expect(secondResume).toMatchObject({
        outcome: 'resumed',
        result: { dueNodeCount: 1, dueNodesRemaining: false },
      });
      const after = await asOwner(workspaceA, (client) =>
        client.query<{ awakened: number; outbox: number }>(
          `select
             (select count(*)::int from app.node_runs
               where workspace_id=$1 and workflow_run_id=$2
                 and due_wakeup_at is not null) awakened,
             (select count(*)::int from app.outbox_events
               where workspace_id=$1 and aggregate_id=$2
                 and job_name='advance-workflow-run') outbox`,
          [workspaceA, hundredOneRunId],
        ),
      );
      expect(after.rows).toEqual([{ awakened: 101, outbox: 2 }]);
    } finally {
      await operator.close();
    }
  });
});
