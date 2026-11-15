import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { useIdentityCommandDatabase } from './command.support.js';

const database = useIdentityCommandDatabase('name_limit');

const longName = 'N'.repeat(200);
const tooLong = 'N'.repeat(257);

function signUp(displayName: string) {
  return database.identity().createUser({
    email: `${randomUUID()}@example.test`,
    displayName,
  });
}

function rename(actorUserId: string, displayName: string) {
  return database.identity().updateUserProfile({
    actorUserId,
    displayName,
    expectedRevision: 1,
    idempotencyKey: `profile-${randomUUID()}`,
  });
}

describe('one display name limit for sign-up and profile edit', () => {
  it('lets a person who signs up with a 200-character name keep it and save it again', async () => {
    const user = await signUp(longName);
    expect(user.displayName).toBe(longName);

    const renamed = await rename(user.id, `${longName.slice(1)}M`);
    expect(renamed.user.displayName).toHaveLength(200);
  });

  it('replays a 200-character rename from its receipt', async () => {
    const user = await database.user('Before Rename');
    const command = {
      actorUserId: user.id,
      displayName: longName,
      expectedRevision: 1,
      idempotencyKey: `profile-${randomUUID()}`,
    };
    const applied = await database.identity().updateUserProfile(command);
    await expect(
      database.identity().updateUserProfile(command),
    ).resolves.toEqual({ ...applied, replayed: true });
  });

  it('refuses a 257-character name at sign-up and at profile edit', async () => {
    await expect(signUp(tooLong)).rejects.toThrow();
    const user = await database.user('Short Name');
    await expect(rename(user.id, tooLong)).rejects.toThrow();
    await expect(
      database.identity().findUserById(user.id),
    ).resolves.toMatchObject({ displayName: 'Short Name' });
  });
});
