import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  connectionSharingRequestSchema,
  connectionSharingResponseSchema,
} from '../../src/schemas/connections.js';

it('bounds grants, canonicalizes identities and rejects duplicates, groups and credential fields', () => {
  const userId = randomUUID();
  const request = {
    mode: 'restricted',
    expectedSharingRevision: 1,
    userIds: [userId.toUpperCase()],
  };
  expect(connectionSharingRequestSchema.parse(request).userIds).toEqual([
    userId,
  ]);
  for (const invalid of [
    { ...request, userIds: [userId, userId.toUpperCase()] },
    { ...request, userIds: Array.from({ length: 101 }, () => randomUUID()) },
    { ...request, mode: 'workspace' },
    { ...request, expectedSharingRevision: 0 },
    { ...request, groupIds: [randomUUID()] },
    { ...request, credential: 'not-accepted' },
  ])
    expect(connectionSharingRequestSchema.safeParse(invalid).success).toBe(
      false,
    );
  expect(
    connectionSharingRequestSchema.parse({
      ...request,
      userIds: [],
      mode: 'workspace',
    }).mode,
  ).toBe('workspace');
});
it('exposes safe sharing metadata with one independent revision', () => {
  expect(
    connectionSharingResponseSchema.parse({
      connectionId: randomUUID(),
      mode: 'restricted',
      revision: 2,
      members: [{ userId: randomUUID(), label: 'Ada', active: true }],
    }),
  ).toMatchObject({
    mode: 'restricted',
    revision: 2,
    members: [{ label: 'Ada', active: true }],
  });
});
