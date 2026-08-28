import { describe, it, expect, vi } from 'vitest';

import {
  FailureNotificationContextV1Schema,
  Pool,
  actorId,
  apiBaseUrl,
  asOwner,
  asRuntime,
  checkpoint,
  createFailureNotificationStore,
  databaseUrl,
  insertRun,
  notificationConnectionId,
  notificationDestinationId,
  notificationSecretVersionId,
  parseDatabaseConfig,
  randomUUID,
  rawStore,
  store,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
  workspaceB,
} from './coordinator-run-store.fixtures.js';

describe('Coordinator scheduling and notification invariants', () => {
  it('defers queued coordination durably until an active entitlement slot is free', async () => {
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.workspace_execution_entitlement_versions (
             workspace_id,version,status,active_run_limit,queued_run_limit,effective_at
           ) values ($1,3,'active',5,100,'-infinity'::timestamptz)`,
        [workspaceA],
      );
      await client.query(
        `update app.workspace_execution_entitlements set current_version=3
            where workspace_id=$1`,
        [workspaceA],
      );
    });
    const activeRunIds = await Promise.all(
      Array.from({ length: 5 }, () => insertRun({ status: 'running' })),
    );
    const runId = await insertRun({});
    await asOwner(workspaceA, (client) =>
      client.query(
        `update app.workspace_execution_entitlements set current_version=2
            where workspace_id=$1`,
        [workspaceA],
      ),
    );
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: '2026-08-25T00:00:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'deferred', revision: 0 });

    const deferred = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ id: string; payload_checksum: string }>(
        `select id,payload_checksum from app.outbox_events
            where workspace_id=$1 and aggregate_id=$2 and job_name='advance-workflow-run'
              and id<>$3
            order by created_at desc limit 1`,
        [workspaceA, runId, delivery.outboxEventId],
      ),
    );
    expect(deferred.rows).toHaveLength(1);
    const retry = deferred.rows[0];
    if (retry === undefined)
      throw new Error('Deferred coordinator row missing');
    await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        `update app.workflow_runs set status='succeeded',completed_at=clock_timestamp()
            where workspace_id=$1 and id=$2`,
        [workspaceA, activeRunIds[0]],
      ),
    );
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery: {
          outboxEventId: retry.id,
          payloadChecksum: retry.payload_checksum,
        },
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        active_runs: number;
        actual_queued: number;
        queued_runs: number;
        run_status: string;
      }>(
        `select counter.active_runs,counter.queued_runs,run.status run_status,
                  (select count(*)::integer from app.workflow_runs queued
                    where queued.workspace_id=counter.workspace_id
                      and queued.status='queued') actual_queued
             from app.workspace_execution_admission_counters counter
             join app.workflow_runs run on run.workspace_id=counter.workspace_id
            where counter.workspace_id=$1 and run.id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows).toEqual([
      {
        active_runs: 5,
        actual_queued: 1,
        queued_runs: 1,
        run_status: 'running',
      },
    ]);
  });

  it('reports database-observed schedule-to-start only for the CAS winner', async () => {
    const due = await asOwner(workspaceA, (client) =>
      client.query<{ scheduled_at: Date }>(
        "select clock_timestamp()-interval '4.25 seconds' scheduled_at",
      ),
    );
    const scheduledAt = due.rows[0]?.scheduled_at.toISOString();
    if (scheduledAt === undefined)
      throw new Error('Database schedule timestamp missing');
    const startedAt = new Date(Date.parse(scheduledAt) + 4_250).toISOString();
    const runId = await insertRun({
      triggerType: 'schedule',
      inputRef: {
        schemaVersion: 1,
        kind: 'inline',
        value: {
          schemaVersion: 1,
          triggerId: randomUUID(),
          nodeId: 'schedule-start-proof',
          scheduledAt,
        },
      },
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'running',
        nextEventSequence: 3,
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'run.started' as const,
          occurredAt: startedAt,
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const delivery = await testDelivery(workspaceA, runId, 0);
    const committed = await rawStore.commitAdvancePlan({
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      delivery,
      plan,
      signal: new AbortController().signal,
    });
    expect(committed).toMatchObject({ kind: 'committed', revision: 1 });
    if (committed.kind !== 'committed')
      throw new Error('Schedule start was not committed');
    expect(committed.scheduleToStartSeconds).toBeGreaterThanOrEqual(4.25);
    expect(committed.scheduleToStartSeconds).toBeLessThan(6);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'already_committed', revision: 1 });
  });

  it('atomically creates one safe failure notification intent and excludes cancellation', async () => {
    const invocationKey = 'failure/primary';
    const runId = await insertRun({
      status: 'running',
      schedulerState: checkpoint({
        runStatus: 'running',
        invocations: [
          {
            invocationKey,
            nodeId: 'primary',
            status: 'running',
            attemptNumber: 1,
          },
        ],
      }),
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    const nodeRunId = randomUUID();
    const attemptId = randomUUID();
    await asRuntime(workerBaseUrl, workspaceA, async (client) => {
      await client.query(
        `insert into app.node_runs (
             id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
             status,side_effect_class,current_attempt_id,current_attempt_number
           ) values ($1,$2,$3,'primary',$4,'{}','running','safe',$5,1)`,
        [nodeRunId, workspaceA, runId, invocationKey, attemptId],
      );
      await client.query(
        `insert into app.node_attempts (
             id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
             safe_error_code,executor_failure_kind,executor_error_kind,
             executor_possibly_dispatched,retry_decision
           ) values ($1,$2,$3,1,'failed','safe','provider.unavailable',
             'failed','provider',false,'pending')`,
        [attemptId, workspaceA, nodeRunId],
      );
    });
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: checkpoint({
        revision: 1,
        runStatus: 'failed',
        nextEventSequence: 4,
        invocations: [
          {
            invocationKey,
            nodeId: 'primary',
            status: 'failed',
            attemptNumber: 1,
          },
        ],
      }),
      events: [
        {
          schemaVersion: 1 as const,
          sequence: 2,
          name: 'node.failed' as const,
          occurredAt: '2026-08-24T10:01:00.000Z',
          invocationKey,
          nodeId: 'primary',
          attemptNumber: 1,
          reasonCode: 'provider.unavailable',
        },
        {
          schemaVersion: 1 as const,
          sequence: 3,
          name: 'run.failed' as const,
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan,
    };
    await expect(store.commitAdvancePlan(input)).resolves.toMatchObject({
      kind: 'committed',
    });
    await expect(store.commitAdvancePlan(input)).resolves.toMatchObject({
      kind: 'already_committed',
    });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        intent_count: number;
        outbox_count: number;
        context: Record<string, unknown>;
      }>(
        `select count(distinct intent.id)::int intent_count,
                  count(distinct outbox.id)::int outbox_count,
                  min(intent.context::text)::jsonb context
           from app.run_failure_notification_intents intent
           join app.outbox_events outbox on outbox.aggregate_id=intent.id
           where intent.workspace_id=$1 and intent.workflow_run_id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows[0]).toMatchObject({ intent_count: 1, outbox_count: 1 });
    const persistedContext = FailureNotificationContextV1Schema.parse(
      proof.rows[0]?.context,
    );
    expect(persistedContext.terminalStatus).toBe('failed');
    expect(persistedContext.primaryFailure).toMatchObject({
      invocationKey,
      safeErrorCode: 'provider.unavailable',
    });
    expect(JSON.stringify(proof.rows[0]?.context)).not.toMatch(
      /errorSummary|secret|input|output|connection|actor/i,
    );
    const hidden = await asRuntime(workerBaseUrl, workspaceB, (client) =>
      client.query(
        `select id from app.run_failure_notification_intents where workflow_run_id=$1`,
        [runId],
      ),
    );
    expect(hidden.rowCount).toBe(0);

    const deliveryStore = createFailureNotificationStore(
      parseDatabaseConfig({
        connectionString: databaseUrl(workerBaseUrl),
        max: 4,
        ownerRole: 'pertexo_owner',
        workerRuntimeRole: 'pertexo_worker',
      }),
    );
    try {
      const identity = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          intent_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select intent.id intent_id,outbox.id outbox_id,outbox.payload_checksum
             from app.run_failure_notification_intents intent
             join app.outbox_events outbox on outbox.aggregate_id=intent.id
             where intent.workflow_run_id=$1 order by outbox.created_at limit 1`,
          [runId],
        ),
      );
      const first = identity.rows[0];
      if (first === undefined) throw new Error('notification fixture missing');
      const claimInput = {
        workspaceId: workspaceA,
        intentId: first.intent_id,
        delivery: {
          outboxEventId: first.outbox_id,
          payloadChecksum: first.payload_checksum,
        },
        recoverySeconds: 1,
        maxAttempts: 3,
      } as const;
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      const claims = await Promise.all([
        deliveryStore.claimDelivery(claimInput),
        deliveryStore.claimDelivery(claimInput),
      ]);
      expect(claims.map(({ kind }) => kind).sort()).toEqual(['busy', 'ready']);
      const ready = claims.find(({ kind }) => kind === 'ready');
      expect(ready?.kind).toBe('ready');
      if (ready?.kind !== 'ready') throw new Error('delivery claim missing');
      expect(ready.context.runId).toBe(runId);

      await asRuntime(apiBaseUrl, workspaceA, async (client) => {
        await client.query(
          `insert into app.failure_notification_destination_versions
               (workspace_id,destination_id,version,kind,side_effect_class,config,created_by)
             select workspace_id,destination_id,2,kind,side_effect_class,
                    jsonb_set(config,'{toEmail}','"changed@example.test"'),$3
               from app.failure_notification_destination_versions
              where workspace_id=$1 and destination_id=$2 and version=1`,
          [workspaceA, notificationDestinationId, actorId],
        );
        await client.query(
          `update app.failure_notification_destinations
                set current_config_version=2,status='disabled'
               where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
      });
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('Delivery destination is unavailable');
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.loadDestination({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          workerId: 'notification-test-worker',
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'email',
        secretVersionId: notificationSecretVersionId,
        toEmail: 'run-store@example.test',
      });

      const disablePool = new Pool({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      });
      const disableClient = await disablePool.connect();
      try {
        await disableClient.query('begin');
        await disableClient.query(
          "select set_config('app.workspace_id',$1,true)",
          [workspaceA],
        );
        await disableClient.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        );
        let fenceSettled = false;
        const disabledFence = deliveryStore
          .fenceDispatch({
            workspaceId: workspaceA,
            intentId: first.intent_id,
            attemptNumber: ready.attemptNumber,
            deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
          })
          .then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          )
          .finally(() => {
            fenceSettled = true;
          });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(fenceSettled).toBe(false);
        await disableClient.query('commit');
        const fenceResult = await disabledFence;
        expect(fenceSettled).toBe(true);
        expect(fenceResult.kind).toBe('rejected');
        if (fenceResult.kind !== 'rejected')
          throw new Error('disabled destination fence unexpectedly committed');
        expect(fenceResult.error).toEqual(
          expect.objectContaining({
            message: 'Delivery dispatch fence failed',
          }),
        );
      } finally {
        await disableClient.query('rollback').catch(() => undefined);
        disableClient.release();
        await disablePool.end();
      }
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        deliveryStore.fenceDispatch({
          workspaceId: workspaceA,
          intentId: first.intent_id,
          attemptNumber: ready.attemptNumber,
          deliveryBinding: `email:v1:sha256:${'a'.repeat(64)}`,
        }),
      ).resolves.toBeUndefined();
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='disabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );
      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ status: string }>(
            `select status from app.run_failure_notification_intents
                where workspace_id=$1 and id=$2`,
            [workspaceA, first.intent_id],
          ),
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'dispatching' }] });
      await asRuntime(apiBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.failure_notification_destinations set status='enabled'
              where workspace_id=$1 and id=$2`,
          [workspaceA, notificationDestinationId],
        ),
      );

      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `update app.run_failure_notification_intents
             set recovery_at=clock_timestamp()-interval '1 second'
             where id=$1`,
          [first.intent_id],
        ),
      );
      await expect(deliveryStore.recoverDue(10, 3)).resolves.toBe(1);
      for (let attempt = 2; attempt <= 3; attempt += 1) {
        const next = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ id: string; payload_checksum: string }>(
            `select id,payload_checksum from app.outbox_events
               where aggregate_id=$1 order by created_at desc,id desc limit 1`,
            [first.intent_id],
          ),
        );
        const outbox = next.rows[0];
        if (outbox === undefined) throw new Error('retry outbox missing');
        const claimed = await deliveryStore.claimDelivery({
          ...claimInput,
          delivery: {
            outboxEventId: outbox.id,
            payloadChecksum: outbox.payload_checksum,
          },
        });
        if (claimed.kind !== 'ready')
          throw new Error('retry was not claimable');
        if (attempt === 2) {
          const rotatedSecretVersionId = randomUUID();
          await asRuntime(apiBaseUrl, workspaceA, async (client) => {
            await client.query(
              `insert into app.connection_secret_versions (
                   id,workspace_id,connection_id,schema_version,kms_key_reference,
                   encrypted_data_key,ciphertext,nonce,auth_tag,created_by
                 ) values ($1,$2,$3,1,'kms','key2','cipher2','BBBBBBBBBBBBBBBB',
                   'BBBBBBBBBBBBBBBBBBBBBB',$4)`,
              [
                rotatedSecretVersionId,
                workspaceA,
                notificationConnectionId,
                actorId,
              ],
            );
            await client.query(
              `update app.connections set current_secret_version_id=$3
                  where workspace_id=$1 and id=$2`,
              [workspaceA, notificationConnectionId, rotatedSecretVersionId],
            );
          });
          await expect(
            deliveryStore.loadDestination({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              workerId: 'notification-test-worker',
              signal: new AbortController().signal,
            }),
          ).rejects.toThrow('Delivery destination is unavailable');
        }
        const workerClock =
          attempt === 2
            ? vi
                .spyOn(Date, 'now')
                .mockReturnValue(Date.parse('2099-01-01T00:00:00.000Z'))
            : undefined;
        try {
          await expect(
            deliveryStore.completeDelivery({
              workspaceId: workspaceA,
              intentId: first.intent_id,
              attemptNumber: claimed.attemptNumber,
              maxAttempts: 3,
              retryDelaySeconds: attempt === 2 ? 30 : 0,
              result: {
                schemaVersion: 1,
                kind: 'retry',
                safeErrorCode: 'provider.unavailable',
                possiblyDispatched: false,
              },
            }),
          ).resolves.toBe('completed');
          if (attempt === 2) {
            const scheduled = await asRuntime(
              workerBaseUrl,
              workspaceA,
              (client) =>
                client.query<{
                  due_in_seconds: number;
                  id: string;
                  payload_checksum: string;
                }>(
                  `select extract(epoch from intent.next_delivery_at-clock_timestamp())::float8 due_in_seconds,
                            outbox.id,outbox.payload_checksum
                     from app.run_failure_notification_intents intent
                     join app.outbox_events outbox on outbox.aggregate_id=intent.id
                     where intent.id=$1 order by outbox.created_at desc,outbox.id desc limit 1`,
                  [first.intent_id],
                ),
            );
            const retry = scheduled.rows[0];
            expect(retry?.due_in_seconds).toBeGreaterThan(25);
            expect(retry?.due_in_seconds).toBeLessThanOrEqual(30);
            if (retry === undefined) throw new Error('retry schedule missing');
            await expect(
              deliveryStore.claimDelivery({
                ...claimInput,
                delivery: {
                  outboxEventId: retry.id,
                  payloadChecksum: retry.payload_checksum,
                },
              }),
            ).resolves.toEqual({ kind: 'busy' });
            await asRuntime(workerBaseUrl, workspaceA, (client) =>
              client.query(
                `update app.run_failure_notification_intents
                   set next_delivery_at=clock_timestamp()-interval '1 second'
                   where id=$1`,
                [first.intent_id],
              ),
            );
          }
        } finally {
          workerClock?.mockRestore();
        }
      }
      const terminal = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{
          status: string;
          run_status: string;
          event_count: number;
        }>(
          `select intent.status,run.status run_status,
                    (select count(*)::int from app.run_events event
                      where event.workflow_run_id=run.id) event_count
             from app.run_failure_notification_intents intent
             join app.workflow_runs run on run.id=intent.workflow_run_id
             where intent.id=$1`,
          [first.intent_id],
        ),
      );
      expect(terminal.rows[0]).toEqual({
        status: 'outcome_unknown',
        run_status: 'failed',
        event_count: 3,
      });

      const exhaustedId = randomUUID();
      await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query(
          `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,
               connection_secret_version_id,delivery_binding,context,context_checksum,
               status,delivery_attempts,dispatch_marked_at,recovery_at,possibly_dispatched
             ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+2,policy_version,
                      destination_id,destination_config_version,'idempotent_with_key',
                      connection_secret_version_id,$3,context,context_checksum,
                      'dispatching',3,clock_timestamp(),clock_timestamp()+interval '1 minute',true
                 from app.run_failure_notification_intents where id=$2`,
          [exhaustedId, first.intent_id, `email:v1:sha256:${'b'.repeat(64)}`],
        ),
      );
      await expect(
        deliveryStore.completeDelivery({
          workspaceId: workspaceA,
          intentId: exhaustedId,
          attemptNumber: 3,
          maxAttempts: 3,
          retryDelaySeconds: 0,
          result: {
            schemaVersion: 1,
            kind: 'retry',
            safeErrorCode: 'delivery.provider_ambiguous',
            possiblyDispatched: true,
          },
        }),
      ).resolves.toBe('completed');
      const exhausted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
        client.query<{ status: string; possibly_dispatched: boolean }>(
          `select status,possibly_dispatched
                 from app.run_failure_notification_intents where id=$1`,
          [exhaustedId],
        ),
      );
      expect(exhausted.rows[0]).toEqual({
        status: 'outcome_unknown',
        possibly_dispatched: true,
      });

      await expect(
        asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query(
            `insert into app.run_failure_notification_intents (
               id,workspace_id,workflow_run_id,terminal_event_sequence,policy_version,
               destination_id,destination_config_version,side_effect_class,
               context,context_checksum,status,delivery_attempts,dispatch_marked_at,recovery_at
             ) select $1,workspace_id,workflow_run_id,terminal_event_sequence+1,policy_version,
                       destination_id,destination_config_version,'unsafe',context,context_checksum,
                      'dispatching',1,clock_timestamp()-interval '2 seconds',
                      clock_timestamp()-interval '1 second'
               from app.run_failure_notification_intents where id=$2`,
            [randomUUID(), first.intent_id],
          ),
        ),
      ).rejects.toThrow(
        'new failure notification intent must exactly match its run pin',
      );
    } finally {
      await deliveryStore.close();
    }

    const canceledRun = await insertRun({
      status: 'canceled',
      schedulerState: checkpoint({ runStatus: 'canceled' }),
    });
    const excluded = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query(
        'select id from app.run_failure_notification_intents where workflow_run_id=$1',
        [canceledRun],
      ),
    );
    expect(excluded.rowCount).toBe(0);
  });
});
