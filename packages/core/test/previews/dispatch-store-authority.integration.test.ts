import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createPreviewAttemptRunStore } from '../../src/previews/attempts/preview-attempt-run.store.js';
import {
  acceptFixture,
  claimFixture,
  actorUserId,
  workspaceId,
  workerPool,
  withOwnerRole,
  withAdmin,
} from './worker.fixture.js';

it('keeps dispatch binding and refuses a revoked connection through the worker store', async () => {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  await withOwnerRole(async (client) => {
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query(
      `insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
       values($1,$2,'email','Dispatch store authority','resend_api_key','active',$3,$4)`,
      [connectionId, workspaceId, secretVersionId, actorUserId],
    );
    await client.query(
      `insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
       values($1,$2,$3,'kms','a','a',$4,$5,$6)`,
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
    secretVersionId,
    expectedProviderKey: 'email',
    expectedAuthType: 'resend_api_key',
  };
  const providerDispatchBinding = `email:sha256:${'c'.repeat(64)}`;
  const connectionString = workerPool.options.connectionString;
  if (connectionString === undefined)
    throw new Error('Worker fixture has no database URL');
  const store = createPreviewAttemptRunStore(
    parseDatabaseConfig({
      connectionString,
      max: 2,
    }),
  );
  try {
    const first = await claimFixture(await acceptFixture(), 'store-first');
    await expect(
      store.markDispatched({
        lease: first.lease,
        workerId: first.workerId,
        connectionFence,
        providerDispatchBinding,
      }),
    ).resolves.toBe('committed');
    const binding = await withAdmin((client) =>
      client.query<{ provider_dispatch_binding: string | null }>(
        'select provider_dispatch_binding from app.preview_attempts where workspace_id=$1 and id=$2',
        [workspaceId, first.lease.previewAttemptId],
      ),
    );
    expect(binding.rows).toEqual([
      { provider_dispatch_binding: providerDispatchBinding },
    ]);
    const next = await claimFixture(await acceptFixture(), 'store-revoked');
    await withOwnerRole(async (client) => {
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await client.query(
        "update app.connections set status='revoked' where id=$1",
        [connectionId],
      );
    });
    await expect(
      store.markDispatched({
        lease: next.lease,
        workerId: next.workerId,
        connectionFence,
        providerDispatchBinding,
      }),
    ).rejects.toMatchObject({ code: 'connection_fence_failed' });
    const refused = await withAdmin((client) =>
      client.query<{
        dispatch_marked_at: Date | null;
        provider_dispatch_binding: string | null;
      }>(
        'select dispatch_marked_at,provider_dispatch_binding from app.preview_attempts where workspace_id=$1 and id=$2',
        [workspaceId, next.lease.previewAttemptId],
      ),
    );
    expect(refused.rows).toEqual([
      { dispatch_marked_at: null, provider_dispatch_binding: null },
    ]);
  } finally {
    await store.close();
  }
});
