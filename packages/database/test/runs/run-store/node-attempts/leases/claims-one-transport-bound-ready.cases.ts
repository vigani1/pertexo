import { it, expect } from 'vitest';

import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  actorId,
  asAdmin,
  asOwner,
  nodeAttemptStore,
  randomUUID,
  versionA,
  workspaceA,
} from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

export function registerClaimsOneTransportBoundReady(): void {
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
      control: { kind: 'none' },
      completedNodeOutputs: [],
      variables: {},
      runInput: { hello: 'world' },
      checkpoint: expect.objectContaining({ runStatus: 'running' }) as unknown,
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
             id,workspace_id,connection_id,kms_key_reference,
             encrypted_data_key,ciphertext,nonce,auth_tag,created_by
           ) values ($1,$2,$3,'kms','a','a',$4,$5,$6)`,
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
    const providerDispatchBinding = 'email:sha256:' + 'a'.repeat(64);
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
        providerDispatchBinding: 'email:sha256:' + 'b'.repeat(64),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(NodeAttemptDispatchBindingMismatchError);
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `insert into app.connection_secret_versions (
             id,workspace_id,connection_id,kms_key_reference,
             encrypted_data_key,ciphertext,nonce,auth_tag,created_by
           ) values ($1,$2,$3,'kms','b','b',$4,$5,$6)`,
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
        `update app.connections set current_secret_version_id=$3,health_revision=health_revision+1
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
    await asOwner(workspaceA, async (client) => {
      await client.query(
        `update app.connections set status='revoked',health_revision=health_revision+1
           where workspace_id=$1 and id=$2`,
        [workspaceA, connectionId],
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
    const heartbeat = await nodeAttemptStore.heartbeat({
      lease: claimed.lease,
      leaseDurationSeconds: 30,
      signal: new AbortController().signal,
    });
    expect(heartbeat.control).toEqual({ kind: 'none' });
    expect(heartbeat.leaseExpiresAt).toBeInstanceOf(Date);
  });
}
