import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseApiTokenCredential } from '../../../src/tenant-access/index.js';
import {
  admin,
  closeWorld,
  openWorld,
  setMembership,
  setStatus,
  setUserStatus,
  team,
  tokens,
  type WorkspaceStatus,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

const request = (
  workspaceId: string,
  ownerUserId: string,
  scopes: readonly ('workflow:read' | 'run:read' | 'run:cancel')[] = [
    'workflow:read',
  ],
) => ({
  workspaceId,
  ownerUserId,
  name: 'Runner',
  scopes: [...scopes],
  expiresInDays: 30,
  idempotencyKey: randomUUID(),
});

async function issued(workspaceId: string, ownerUserId: string) {
  const created = await tokens.create(request(workspaceId, ownerUserId));
  if (created.replayed) throw new Error('A new key replayed');
  const credential = parseApiTokenCredential(created.secret);
  if (credential === undefined) throw new Error('The secret did not parse');
  return { tokenId: created.token.id, credential };
}

describe('signing in with a token', () => {
  it('answers with the scopes it was issued, and no others', async () => {
    const { workspaceId, owner } = await team();
    const { credential, tokenId } = await issued(workspaceId, owner);
    expect(await tokens.authenticate(credential)).toMatchObject({
      tokenId,
      workspaceId,
      ownerUserId: owner,
      scopes: ['workflow:read'],
    });
  });

  it('refuses a revoked one', async () => {
    const { workspaceId, owner } = await team();
    const { credential, tokenId } = await issued(workspaceId, owner);
    await tokens.revoke({
      workspaceId,
      ownerUserId: owner,
      tokenId,
      idempotencyKey: randomUUID(),
    });
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });

  it('refuses an expired one', async () => {
    const { workspaceId, owner } = await team();
    const { credential, tokenId } = await issued(workspaceId, owner);
    await admin.query(
      `update app.api_tokens set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' where id=$1`,
      [tokenId],
    );
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });

  it('refuses one whose owner changed role since', async () => {
    const { workspaceId, admin: manager } = await team();
    const { credential } = await issued(workspaceId, manager);
    await admin.query(
      "update app.workspace_memberships set role='viewer',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [workspaceId, manager],
    );
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });

  it.each<WorkspaceStatus>([
    'suspended',
    'pending_deletion',
    'purging',
    'deleted',
  ])('refuses any on a workspace %s', async (status) => {
    const { workspaceId, owner } = await team();
    const { credential } = await issued(workspaceId, owner);
    await setStatus(workspaceId, status);
    expect(await tokens.authenticate(credential)).toBeUndefined();
  });

  it('refuses a removed member’s and a suspended user’s', async () => {
    const { workspaceId, admin: manager, builder } = await team();
    const removed = await issued(workspaceId, manager);
    const suspended = await issued(workspaceId, builder);
    await setMembership(workspaceId, manager, 'removed');
    await setUserStatus(builder, 'suspended');
    expect(await tokens.authenticate(removed.credential)).toBeUndefined();
    expect(await tokens.authenticate(suspended.credential)).toBeUndefined();
  });
});

describe('what a role can issue', () => {
  it('refuses a scope beyond the role, and issues nothing', async () => {
    const { workspaceId, viewer } = await team();
    await expect(
      tokens.create(request(workspaceId, viewer, ['run:cancel'])),
    ).rejects.toMatchObject({ reason: 'scope_forbidden' });
    const { rows } = await admin.query(
      'select id from app.api_tokens where workspace_id=$1',
      [workspaceId],
    );
    expect(rows).toEqual([]);
  });

  it('lists what the role may ask for', async () => {
    const { workspaceId, viewer, operator } = await team();
    const asViewer = await tokens.list({
      workspaceId,
      ownerUserId: viewer,
      limit: 1,
    });
    const asOperator = await tokens.list({
      workspaceId,
      ownerUserId: operator,
      limit: 1,
    });
    expect(asViewer.availableScopes).not.toContain('run:cancel');
    expect(asOperator.availableScopes).toContain('run:cancel');
  });
});

describe('managing tokens as a workspace leaves service', () => {
  it.each<WorkspaceStatus>(['suspended', 'pending_deletion'])(
    'on %s refuses a new one, but lists and revokes',
    async (status) => {
      const { workspaceId, owner } = await team();
      const { tokenId } = await issued(workspaceId, owner);
      await setStatus(workspaceId, status);
      await expect(
        tokens.create(request(workspaceId, owner)),
      ).rejects.toMatchObject({ reason: 'authority_inactive' });
      const page = await tokens.list({
        workspaceId,
        ownerUserId: owner,
        limit: 5,
      });
      expect(page.items.map(({ id }) => id)).toEqual([tokenId]);
      await expect(
        tokens.revoke({
          workspaceId,
          ownerUserId: owner,
          tokenId,
          idempotencyKey: randomUUID(),
        }),
      ).resolves.toMatchObject({ token: { status: 'revoked' } });
    },
  );

  it.each<WorkspaceStatus>(['purging', 'deleted'])(
    'on %s refuses them all',
    async (status) => {
      const { workspaceId, owner } = await team();
      const { tokenId } = await issued(workspaceId, owner);
      await setStatus(workspaceId, status);
      const refused = { reason: 'authority_inactive' };
      await expect(
        tokens.create(request(workspaceId, owner)),
      ).rejects.toMatchObject(refused);
      await expect(
        tokens.list({ workspaceId, ownerUserId: owner, limit: 5 }),
      ).rejects.toMatchObject(refused);
      await expect(
        tokens.revoke({
          workspaceId,
          ownerUserId: owner,
          tokenId,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject(refused);
    },
  );
});
