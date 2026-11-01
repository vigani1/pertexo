import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  admin,
  identities,
  tokens,
  input,
  parsed,
  createOwner,
} from './fixture.js';

export function registerRevokesTokensOnWorkspaceDeletion(): void {
  // db-runs-02: ADR 013 step 2 revokes API keys; step 3 restores to `suspended`.
  it('revokes API tokens on deletion so a restore does not revive them', async () => {
    const owner = await createOwner();
    const created = await tokens.create({
      ...input(),
      ...owner,
      idempotencyKey: randomUUID(),
    });
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    const lifecycle = (
      commandType: 'deletion_requested' | 'deletion_restored',
    ) =>
      identities.requestWorkspaceLifecycleOperation({
        workspaceId: owner.workspaceId,
        actorUserId: owner.ownerUserId,
        commandType,
        reason: 'Closing the workspace',
        idempotencyKey: randomUUID(),
      });

    await lifecycle('deletion_requested');
    const revoked = await admin.query<{ revoked: boolean }>(
      'select revoked_at is not null revoked from app.api_tokens where id=$1',
      [created.token.id],
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);

    await lifecycle('deletion_restored');
    const workspace = await admin.query<{ status: string }>(
      'select status from app.workspaces where id=$1',
      [owner.workspaceId],
    );
    expect(workspace.rows).toEqual([{ status: 'suspended' }]);
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });
  it('keeps revoked API tokens revoked after a reactivation', async () => {
    const owner = await createOwner();
    const created = await tokens.create({
      ...input(),
      ...owner,
      idempotencyKey: randomUUID(),
    });
    if (created.replayed)
      throw new Error('First creation unexpectedly replayed');
    const credential = parsed(created.secret);
    const lifecycle = (
      commandType: 'deletion_requested' | 'deletion_restored',
    ) =>
      identities.requestWorkspaceLifecycleOperation({
        workspaceId: owner.workspaceId,
        actorUserId: owner.ownerUserId,
        commandType,
        reason: 'Closing the workspace',
        idempotencyKey: randomUUID(),
      });
    await lifecycle('deletion_requested');
    await lifecycle('deletion_restored');

    await identities.requestWorkspaceLifecycleOperation({
      workspaceId: owner.workspaceId,
      actorUserId: owner.ownerUserId,
      commandType: 'reactivated',
      reason: 'Workspace reactivated',
      idempotencyKey: randomUUID(),
    });

    const workspace = await admin.query<{ status: string }>(
      'select status from app.workspaces where id=$1',
      [owner.workspaceId],
    );
    expect(workspace.rows).toEqual([{ status: 'active' }]);
    const revoked = await admin.query<{ revoked: boolean }>(
      'select revoked_at is not null revoked from app.api_tokens where id=$1',
      [created.token.id],
    );
    expect(revoked.rows).toEqual([{ revoked: true }]);
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });
}
