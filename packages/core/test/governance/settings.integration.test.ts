import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGovernanceStore } from '../../src/governance/index.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { useIdentityCommandDatabase } from '../identity/command.support.js';

const db = useIdentityCommandDatabase('gov_reviewers');
async function setup() {
  const owner = await db.user('Policy owner');
  const workspaceId = await db.workspace(owner.id);
  const connectionString = db.authenticationPool().options.connectionString;
  if (typeof connectionString !== 'string')
    throw new Error('Missing fixture database');
  const store = createGovernanceStore(
    parseDatabaseConfig({ connectionString, max: 2 }),
  );
  const scope = { workspaceId, actorId: owner.id };
  return {
    store,
    scope,
    command: {
      ...scope,
      expectedRevision: 1,
      requirePublishApproval: true,
      idempotencyKey: randomUUID(),
    },
  };
}
async function settingsFacts(workspaceId: string) {
  return db.asAdmin(
    "select metadata from app.audit_events where workspace_id=$1 and action='workspace.governance_changed'",
    [workspaceId],
  );
}

describe('publication approval enablement', () => {
  it('refuses a sole reviewer or an owner of another workspace, rolls back its receipt and accepts the same key after adding a reviewer', async () => {
    const f = await setup();
    try {
      const other = await db.user('Other owner');
      await db.workspace(other.id);
      await expect(f.store.configure(f.command)).rejects.toMatchObject({
        reason: 'invalid',
        message:
          'Add another active owner or admin before requiring approval to publish.',
      });
      expect(await f.store.settings(f.scope)).toMatchObject({
        revision: 1,
        requirePublishApproval: false,
      });
      expect(await settingsFacts(f.scope.workspaceId)).toEqual([]);
      await db.member(f.scope.workspaceId, other.id, 'admin');
      const saved = await f.store.configure(f.command);
      expect(saved).toMatchObject({
        revision: 2,
        requirePublishApproval: true,
      });
      expect(await f.store.configure(f.command)).toEqual(saved);
      expect(await settingsFacts(f.scope.workspaceId)).toEqual([
        { metadata: saved },
      ]);
    } finally {
      await f.store.close();
    }
  });
  it.each([
    ['builder', 'active', 'active'],
    ['admin', 'suspended', 'active'],
    ['admin', 'removed', 'active'],
    ['admin', 'active', 'suspended'],
    ['owner', 'active', 'suspended'],
  ] as const)(
    'refuses a %s with membership %s and account %s',
    async (role, membershipStatus, accountStatus) => {
      const f = await setup();
      try {
        const person = await db.user('Ineligible reviewer');
        if (role === 'owner')
          await db.asAdmin(
            "update app.workspace_memberships set role='admin' where workspace_id=$1 and user_id=$2",
            [f.scope.workspaceId, f.scope.actorId],
          );
        await db.member(f.scope.workspaceId, person.id, role);
        await db.asAdmin(
          'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
          [f.scope.workspaceId, person.id, membershipStatus],
        );
        await db.asAdmin('update app.users set status=$2 where id=$1', [
          person.id,
          accountStatus,
        ]);
        await expect(f.store.configure(f.command)).rejects.toMatchObject({
          reason: 'invalid',
        });
        expect(await f.store.settings(f.scope)).toMatchObject({
          revision: 1,
          requirePublishApproval: false,
        });
        expect(await settingsFacts(f.scope.workspaceId)).toEqual([]);
      } finally {
        await f.store.close();
      }
    },
  );
  it.each(['owner', 'admin'] as const)(
    'allows another %s and preserves replay, retention edits and explicit disabling after their removal',
    async (role) => {
      const f = await setup();
      try {
        const person = await db.user('Reviewer');
        if (role === 'owner')
          await db.asAdmin(
            "update app.workspace_memberships set role='admin' where workspace_id=$1 and user_id=$2",
            [f.scope.workspaceId, f.scope.actorId],
          );
        await db.member(f.scope.workspaceId, person.id, role);
        const enabled = await f.store.configure(f.command);
        await db.asAdmin(
          "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
          [f.scope.workspaceId, person.id],
        );
        expect(await f.store.configure(f.command)).toEqual(enabled);
        const retained = await f.store.configure({
          ...f.scope,
          expectedRevision: 2,
          auditRetentionDays: 30,
          idempotencyKey: randomUUID(),
        });
        expect(retained).toMatchObject({
          revision: 3,
          requirePublishApproval: true,
        });
        const disabled = await f.store.configure({
          ...f.scope,
          expectedRevision: 3,
          requirePublishApproval: false,
          idempotencyKey: randomUUID(),
        });
        expect(disabled).toMatchObject({
          revision: 4,
          requirePublishApproval: false,
        });
        expect(await f.store.configure(f.command)).toEqual(enabled);
        expect(await f.store.settings(f.scope)).toEqual(disabled);
        expect(await settingsFacts(f.scope.workspaceId)).toHaveLength(3);
      } finally {
        await f.store.close();
      }
    },
  );
  it('serializes racing enables and keeps stale-revision conflicts ahead of reviewer eligibility', async () => {
    const f = await setup();
    try {
      const person = await db.user('Reviewer');
      await db.member(f.scope.workspaceId, person.id, 'admin');
      const attempts = await Promise.allSettled([
        f.store.configure(f.command),
        f.store.configure({ ...f.command, idempotencyKey: randomUUID() }),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = attempts.filter(
        (attempt) => attempt.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: 'rejected',
        reason: { reason: 'conflict' },
      });
      expect(await settingsFacts(f.scope.workspaceId)).toHaveLength(1);
      await db.asAdmin(
        "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
        [f.scope.workspaceId, person.id],
      );
      await f.store.configure({
        ...f.scope,
        expectedRevision: 2,
        requirePublishApproval: false,
        idempotencyKey: randomUUID(),
      });
      await expect(
        f.store.configure({ ...f.command, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ reason: 'conflict' });
    } finally {
      await f.store.close();
    }
  });
});
