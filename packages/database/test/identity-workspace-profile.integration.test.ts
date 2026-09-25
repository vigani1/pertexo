import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { UserProfileCommandConflictError } from '../src/testing.js';
import { useIdentityCommandDatabase } from './support/identity-command.integration.support.js';

const database = useIdentityCommandDatabase('user_profile');

function rename(
  actorUserId: string,
  displayName: string,
  expectedRevision = 1,
) {
  return {
    actorUserId,
    displayName,
    expectedRevision,
    idempotencyKey: `profile-${randomUUID()}`,
  };
}

async function profileFacts(userId: string) {
  return database.asAdmin<{ event_type: string }>(
    `select event_type from app.identity_security_audit_facts
      where user_id=$1 and event_type='profile.display_name_changed'`,
    [userId],
  );
}

describe('self-service display name (ADR 043)', () => {
  it('renames once, replays the exact command and audits only real changes', async () => {
    const user = await database.user('Before Rename');
    await database.sessions(user.id);
    const command = rename(user.id, '  Ada Lovelace  ');

    const applied = await database.identity().updateUserProfile(command);
    expect(applied).toMatchObject({
      user: { id: user.id, displayName: 'Ada Lovelace', profileRevision: 2 },
      changed: true,
      replayed: false,
    });
    await expect(
      database.identity().findUserById(user.id),
    ).resolves.toMatchObject({
      displayName: 'Ada Lovelace',
      profileRevision: 2,
    });
    await expect(database.liveSessions(user.id)).resolves.toEqual({
      opaque: 1,
      betterAuth: 1,
    });

    await expect(
      database.identity().updateUserProfile(command),
    ).resolves.toEqual({ ...applied, replayed: true });
    await expect(
      database
        .identity()
        .updateUserProfile({ ...command, displayName: 'Someone Else' }),
    ).rejects.toMatchObject({ reason: 'idempotency_conflict' });
    await expect(
      database.identity().updateUserProfile(rename(user.id, 'Stale Name', 1)),
    ).rejects.toMatchObject({ reason: 'revision_conflict' });
    await expect(
      database.identity().updateUserProfile(rename(user.id, 'Ada Lovelace', 2)),
    ).resolves.toMatchObject({
      user: { profileRevision: 2 },
      changed: false,
      replayed: false,
    });
    await expect(profileFacts(user.id)).resolves.toHaveLength(1);
  });

  it('serializes same-revision renames so exactly one applies', async () => {
    const user = await database.user('Concurrent Name');
    const outcomes = await Promise.allSettled([
      database.identity().updateUserProfile(rename(user.id, 'First Writer')),
      database.identity().updateUserProfile(rename(user.id, 'Second Writer')),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejected?.status !== 'rejected')
      throw new Error('A concurrent rename should have failed');
    expect(rejected.reason).toBeInstanceOf(UserProfileCommandConflictError);
    expect(rejected.reason).toMatchObject({ reason: 'revision_conflict' });
    await expect(profileFacts(user.id)).resolves.toHaveLength(1);
  });

  it('rejects inactive users and names outside the contract', async () => {
    const user = await database.user('Validated Name');
    for (const displayName of ['   ', 'x'.repeat(129), 'Line\nBreak'])
      await expect(
        database.identity().updateUserProfile(rename(user.id, displayName)),
      ).rejects.toBeDefined();
    await database.asAdmin(
      `update app.users set status='suspended' where id=$1`,
      [user.id],
    );
    await expect(
      database.identity().updateUserProfile(rename(user.id, 'Suspended Name')),
    ).rejects.toMatchObject({ reason: 'user_inactive' });
    await expect(
      database
        .identity()
        .updateUserProfile(rename(randomUUID(), 'Missing User')),
    ).rejects.toMatchObject({ reason: 'user_inactive' });
    await expect(profileFacts(user.id)).resolves.toHaveLength(0);
  });

  it('keeps receipts identity scoped and append-only for the API role', async () => {
    const user = await database.user('Receipt Owner');
    await database
      .identity()
      .updateUserProfile(rename(user.id, 'Receipt Name'));
    const [grants] = await database.asAdmin<{
      can_delete: boolean;
      can_update_key: boolean;
      can_update_profile_revision: boolean;
    }>(
      `select
         has_table_privilege('pertexo_api','app.user_profile_command_receipts','DELETE') can_delete,
         has_column_privilege('pertexo_api','app.user_profile_command_receipts','key_hash','UPDATE') can_update_key,
         has_column_privilege('pertexo_api','app.users','profile_revision','UPDATE') can_update_profile_revision`,
    );
    expect(grants).toEqual({
      can_delete: false,
      can_update_key: false,
      can_update_profile_revision: true,
    });
    const receipts = await database.asAdmin<{
      result_ref: Record<string, unknown>;
    }>(
      `select result_ref from app.user_profile_command_receipts where actor_user_id=$1`,
      [user.id],
    );
    expect(receipts).toHaveLength(1);
    expect(Object.keys(receipts[0]?.result_ref ?? {}).sort()).toEqual([
      'changed',
      'displayName',
      'profileRevision',
      'updatedAt',
    ]);
  });
});
