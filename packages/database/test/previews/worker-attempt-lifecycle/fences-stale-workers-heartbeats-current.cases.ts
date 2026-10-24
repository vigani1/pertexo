import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { completePreviewAttempt } from '../../../src/previews/attempts/completion.repository.js';
import { heartbeatPreviewLease } from '../../../src/previews/attempts/heartbeat.repository.js';
import { markPreviewDispatched } from '../../../src/previews/attempts/dispatch.repository.js';
import { PREVIEW_STATUS } from '../../../src/previews/state.js';
import { PreviewAttemptStateError } from '../../../src/previews/errors.js';
import {
  acceptFixture,
  actorUserId,
  claimFixture,
  expireLease,
  withAdmin,
  withOwnerRole,
  workerPool,
  workspaceId,
} from '../worker.fixture.js';

export function registerFencesStaleWorkersHeartbeatsCurrent(): void {
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
          output: { kind: 'inline', value: 'stale' },
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
           id,workspace_id,connection_id,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,'kms','a','a',$4,$5,$6)`,
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
        providerDispatchBinding: 'email:sha256:' + 'c'.repeat(64),
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
        providerDispatchBinding: 'email:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).resolves.toBe('committed');
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        connectionFence,
        providerDispatchBinding: 'email:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).resolves.toBe('committed');
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        providerDispatchBinding: 'email:sha256:' + 'd'.repeat(64),
        workerId: second.workerId,
      }),
    ).rejects.toMatchObject({ code: 'dispatch_binding_mismatch' });
    await withOwnerRole(async (client) => {
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.connection_secret_versions (
           id,workspace_id,connection_id,kms_key_reference,
           encrypted_data_key,ciphertext,nonce,auth_tag,created_by
         ) values ($1,$2,$3,'kms','b','b',$4,$5,$6)`,
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
        `update app.connections set current_secret_version_id=$3,health_revision=health_revision+1
         where workspace_id=$1 and id=$2`,
        [workspaceId, connectionId, nextSecretVersionId],
      );
    });
    await expect(
      markPreviewDispatched(workerPool, {
        lease: second.lease,
        connectionFence,
        providerDispatchBinding: 'email:sha256:' + 'c'.repeat(64),
        workerId: second.workerId,
      }),
    ).rejects.toMatchObject({ code: 'connection_fence_failed' });
  });

  it('caps a renewed lease at its immutable execution deadline', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-deadline-cap',
    );
    const deadline = await withAdmin(async (client) => {
      const result = await client.query<{ execution_deadline_at: Date }>(
        `update app.preview_runs
         set execution_deadline_at=clock_timestamp()+interval '30 seconds'
         where workspace_id=$1 and id=$2 returning execution_deadline_at`,
        [workspaceId, claimed.lease.previewRunId],
      );
      return result.rows[0]?.execution_deadline_at;
    });
    expect(deadline).toBeInstanceOf(Date);
    await expect(
      heartbeatPreviewLease(workerPool, {
        lease: claimed.lease,
        leaseDurationSeconds: 3_600,
        workerId: claimed.workerId,
      }),
    ).resolves.toEqual({
      attemptLeaseExpiresAt: deadline,
      runExecutionDeadlineAt: deadline,
    });
  });

  it('separates lease expiry from fence replacement for truthful completion', async () => {
    const claimed = await claimFixture(
      await acceptFixture(),
      'worker-preview-expired-current',
      5,
    );
    await expireLease(claimed.fixture.previewAttemptId);

    await expect(
      markPreviewDispatched(workerPool, {
        lease: claimed.lease,
        workerId: claimed.workerId,
      }),
    ).rejects.toMatchObject({ code: 'dispatch_marker_lost' });
    await expect(
      heartbeatPreviewLease(workerPool, {
        lease: claimed.lease,
        leaseDurationSeconds: 30,
        workerId: claimed.workerId,
      }),
    ).rejects.toMatchObject({ code: 'heartbeat_lost' });

    // Expiry stops new provider authority, while an unchanged owner/token may
    // still record provider truth until reconciliation replaces the fence.
    await expect(
      completePreviewAttempt(workerPool, {
        delivery: claimed.fixture.delivery,
        lease: claimed.lease,
        outcome: {
          output: { kind: 'inline', value: 'confirmed' },
          status: PREVIEW_STATUS.succeeded,
        },
        workerId: claimed.workerId,
      }),
    ).resolves.toEqual({ kind: 'committed' });
  });
}
