import { randomUUID } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';
import { describe, expect, it } from 'vitest';

import {
  claimPreviewDelivery,
  completePreviewAttempt,
  heartbeatPreviewLease,
  markPreviewDispatched,
  PREVIEW_STATUS,
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
  type PreviewDelivery,
} from '../src/preview-execution.js';
import {
  acceptFixture,
  actorUserId,
  apiPool,
  claimFixture,
  expireLease,
  expectPgCode,
  previewTerminalFacts,
  scopedQuery,
  withAdmin,
  withOwnerRole,
  workerPool,
  workspaceId,
  workflowId,
} from './support/preview-worker-fixture.js';
import { withTenantScopedClient } from '../src/tenant-access/workspace.js';

describe('preview worker attempt lifecycle', () => {
  it('claims a queued attempt with pinned identity and completes truthfully', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-a',
    );
    expect(claimed.lease).toMatchObject({
      attemptFenceToken: 1,
      definitionKey: 'http.request',
      definitionVersion: 1,
      dryRun: 'not_supported',
      executorKey: 'http.request',
      executorVersion: 2,
      mayCauseExternalSideEffect: true,
      mayContactProvider: true,
      nodeId: 'node-1',
      operationKey: 'request',
      providerKey: 'http',
      sideEffectClass: 'unsafe',
      workspaceId,
      workflowId,
    });
    expect(claimed.lease.input).toMatchObject({ kind: 'inline' });
    expect(claimed.lease.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u,
    );
    expect(claimed.lease.executionDeadlineAt.getTime()).toBeGreaterThan(
      Date.now(),
    );

    const attemptState = await scopedQuery<{
      status: string;
      started_at: Date | null;
    }>(
      `select status,started_at from app.preview_attempts
       where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewAttemptId],
    );
    expect(attemptState.rows[0]).toMatchObject({ status: 'running' });
    expect(attemptState.rows[0]?.started_at).not.toBeNull();

    const completed = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        output: {
          schemaVersion: 1,
          kind: 'inline',
          value: { done: true },
        },
        status: PREVIEW_STATUS.succeeded,
      },
      workerId: claimed.workerId,
    });
    expect(completed.kind).toBe('committed');

    const runState = await scopedQuery<{
      status: string;
      output_ref: unknown;
      safe_error_code: string | null;
      completed_at: Date | null;
    }>(
      `select status,output_ref,safe_error_code,completed_at
       from app.preview_runs where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewRunId],
    );
    expect(runState.rows[0]).toMatchObject({
      safe_error_code: null,
      status: 'succeeded',
    });
    expect(runState.rows[0]?.output_ref).not.toBeNull();
    expect(runState.rows[0]?.completed_at).not.toBeNull();

    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    const auditId = facts.audit[0]?.id;
    const usageId = facts.usage[0]?.id;
    const uuidV7Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    expect(auditId).toMatch(uuidV7Pattern);
    expect(usageId).toMatch(uuidV7Pattern);
    expect(facts.audit).toEqual([
      {
        actor_user_id: actorUserId,
        id: auditId,
        metadata: {
          schemaVersion: 1,
          status: PREVIEW_STATUS.succeeded,
          workflowId,
          nodeId: 'node-1',
          definitionKey: 'http.request',
          definitionVersion: 1,
          executorKey: 'http.request',
          executorVersion: 2,
          dryRun: 'not_supported',
          sideEffectClass: 'unsafe',
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          previewAttemptId: claimed.fixture.previewAttemptId,
        },
        request_id: 'preview-request-id',
        trace_id: 'preview-trace-id',
      },
    ]);
    expect(facts.usage).toEqual([
      {
        category: 'preview_execution',
        id: usageId,
        idempotency_key: `preview-terminal:${claimed.fixture.previewRunId}`,
        metadata: {
          schemaVersion: 1,
          status: PREVIEW_STATUS.succeeded,
          definitionKey: 'http.request',
          executorKey: 'http.request',
          sideEffectClass: 'unsafe',
        },
        quantity: '1',
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain('hello');
    expect(JSON.stringify(facts)).not.toContain('done');

    const otherWorkspaceFacts = await withTenantScopedClient(
      apiPool,
      { workspaceId: randomUUID() },
      (client) =>
        client.query<{ audit_count: string; usage_count: string }>(
          `select
             (select count(*)::text from app.audit_events
               where target_id=$1) as audit_count,
             (select count(*)::text from app.usage_events
               where resource_id=$1) as usage_count`,
          [claimed.fixture.previewRunId],
        ),
    );
    expect(otherWorkspaceFacts.rows).toEqual([
      { audit_count: '0', usage_count: '0' },
    ]);
  });

  it('makes exact redelivery after a terminal outcome an inbox duplicate', async () => {
    const fixture = await acceptFixture();
    const claimed = await claimFixture(fixture, 'worker-preview-b');
    const committed = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(committed.kind).toBe('committed');

    const redelivered = await claimPreviewDelivery(workerPool, {
      delivery: fixture.delivery,
      leaseDurationSeconds: 30,
      previewAttemptId: fixture.previewAttemptId,
      previewRunId: fixture.previewRunId,
      workerId: 'worker-preview-c',
      workspaceId,
    });
    expect(redelivered).toEqual({ kind: 'duplicate' });

    // Completing again is an idempotent duplicate, not a second effect.
    const replayCompletion = await completePreviewAttempt(workerPool, {
      delivery: claimed.fixture.delivery,
      lease: claimed.lease,
      outcome: {
        safeErrorCode: 'preview.provider_rejected',
        status: PREVIEW_STATUS.failed,
      },
      workerId: claimed.workerId,
    });
    expect(replayCompletion.kind).toBe('duplicate');
    const facts = await previewTerminalFacts(fixture.previewRunId);
    expect(facts.audit).toHaveLength(1);
    expect(facts.usage).toHaveLength(1);
  });

  it('rolls the terminal transition back when its facts cannot commit', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-terminal-fact-atomicity',
    );
    await withTenantScopedClient(workerPool, { workspaceId }, (client) =>
      client.query(
        `insert into app.usage_events (
           id,workspace_id,category,quantity,resource_type,resource_id,
           idempotency_key,metadata
         ) values ($1,$2,'preview_execution',1,'preview-run',$3,$4,'{}')`,
        [
          uuidv7(),
          workspaceId,
          claimed.fixture.previewRunId,
          `preview-terminal:${claimed.fixture.previewRunId}`,
        ],
      ),
    );

    await expect(
      completePreviewAttempt(workerPool, {
        delivery: claimed.fixture.delivery,
        lease: claimed.lease,
        outcome: {
          safeErrorCode: 'preview.provider_rejected',
          status: PREVIEW_STATUS.failed,
        },
        workerId: claimed.workerId,
      }),
    ).rejects.toSatisfy(expectPgCode('23505'));

    const state = await scopedQuery<{ status: string }>(
      `select status from app.preview_runs
        where workspace_id=$1 and id=$2`,
      [workspaceId, claimed.fixture.previewRunId],
    );
    expect(state.rows).toEqual([{ status: PREVIEW_STATUS.running }]);
    const facts = await previewTerminalFacts(claimed.fixture.previewRunId);
    expect(facts.audit).toHaveLength(0);
    expect(facts.usage).toHaveLength(1);
  });

  it('rejects a forged checksum reuse of a valid outbox row with a security fact', async () => {
    const fixture = await acceptFixture();
    const forged: PreviewDelivery = {
      outboxEventId: fixture.delivery.outboxEventId,
      payloadChecksum: 'f'.repeat(64),
    };
    await expect(
      claimPreviewDelivery(workerPool, {
        delivery: forged,
        leaseDurationSeconds: 30,
        previewAttemptId: fixture.previewAttemptId,
        previewRunId: fixture.previewRunId,
        workerId: 'worker-preview-d',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(PreviewDeliveryMismatchError);

    const facts = await scopedQuery(
      `select count(*)::text as count from app.transport_security_audit_facts
       where workspace_id=$1 and message_id=$2`,
      [workspaceId, fixture.delivery.outboxEventId],
    );
    expect(facts.rows[0]).toEqual({ count: '1' });
  });

  it('fences stale workers and heartbeats only the current owner', async () => {
    const first = await claimFixture(
      await acceptFixture(),
      'worker-preview-e',
      5,
    );
    await expireLease(first.fixture.previewAttemptId);
    const second = await claimFixture(first.fixture, 'worker-preview-f');
    expect(second.lease.attemptFenceToken).toBe(
      first.lease.attemptFenceToken + 1,
    );

    await expect(
      markPreviewDispatched(workerPool, {
        lease: first.lease,
        workerId: first.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    await expect(
      heartbeatPreviewLease(workerPool, {
        lease: first.lease,
        leaseDurationSeconds: 30,
        workerId: first.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: first.fixture.delivery,
        lease: first.lease,
        outcome: {
          output: { schemaVersion: 1, kind: 'inline', value: 'stale' },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: first.workerId,
      }),
    ).rejects.toBeInstanceOf(PreviewAttemptStateError);

    const beat = await heartbeatPreviewLease(workerPool, {
      lease: second.lease,
      leaseDurationSeconds: 45,
      workerId: second.workerId,
    });
    expect(beat.attemptLeaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(beat.runExecutionDeadlineAt.getTime()).toBeGreaterThan(Date.now());
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const nextSecretVersionId = randomUUID();
    await withOwnerRole(async (client) => {
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.connections (
           id,workspace_id,provider_key,name,auth_type,status,
           current_secret_version_id,created_by
         ) values ($1,$2,'email',$3,'resend_api_key','active',$4,$5)`,
        [
          connectionId,
          workspaceId,
          `Preview fence ${connectionId}`,
          secretVersionId,
          actorUserId,
        ],
      );
      await client.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','a','a',$4,$5,$6)`,
        [
          secretVersionId,
          workspaceId,
          connectionId,
          'a'.repeat(16),
          'a'.repeat(22),
          actorUserId,
        ],
      );
    });
    const connectionFence = {
      connectionId,
      expectedProviderKey: 'email',
      expectedAuthType: 'resend_api_key',
      secretVersionId,
    } as const;
    await withAdmin((client) =>
      client.query(`update app.workspaces set status='suspended' where id=$1`, [
        workspaceId,
      ]),
    );
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        connectionFence,
        providerDispatchBinding: 'email:v1:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).rejects.toMatchObject({ code: 'connection_fence_failed' });
    await withAdmin((client) =>
      client.query(`update app.workspaces set status='active' where id=$1`, [
        workspaceId,
      ]),
    );
    await expect(
      withAdmin(async (client) => {
        const evidence = await client.query<{
          dispatch_marked_at: Date | null;
          provider_dispatch_binding: string | null;
        }>(
          `select dispatch_marked_at,provider_dispatch_binding
           from app.preview_attempts where workspace_id=$1 and id=$2`,
          [workspaceId, second.lease.previewAttemptId],
        );
        return evidence.rows[0];
      }),
    ).resolves.toEqual({
      dispatch_marked_at: null,
      provider_dispatch_binding: null,
    });
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        connectionFence,
        providerDispatchBinding: 'email:v1:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).resolves.toBe('committed');
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        connectionFence,
        providerDispatchBinding: 'email:v1:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).resolves.toBe('committed');
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        providerDispatchBinding: 'email:v1:sha256:' + 'd'.repeat(64),
        workerId: second.workerId,
      }),
    ).rejects.toMatchObject({ code: 'dispatch_binding_mismatch' });
    await withOwnerRole(async (client) => {
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,schema_version,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,1,'kms','b','b',$4,$5,$6)`,
        [
          nextSecretVersionId,
          workspaceId,
          connectionId,
          'b'.repeat(16),
          'b'.repeat(22),
          actorUserId,
        ],
      );
      await client.query(
        `update app.connections set current_secret_version_id=$3
         where workspace_id=$1 and id=$2`,
        [workspaceId, connectionId, nextSecretVersionId],
      );
    });
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        connectionFence,
        providerDispatchBinding: 'email:v1:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).rejects.toMatchObject({ code: 'connection_fence_failed' });
  });
});
