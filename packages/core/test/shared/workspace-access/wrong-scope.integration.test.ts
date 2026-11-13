import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { withWorkspaceAccess } from '../../../src/shared/index.js';

import { userId } from '../../lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  member,
  pool,
} from '../../variables/variable-configuration.fixture.js';
import {
  anyMember,
  RENAME,
  workspaceName,
} from './workspace-access.support.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

const MODES = ['read', 'change', 'exclusive'] as const;

type WrongScope = (workspaceId: string) => Promise<{
  workspaceId: string;
  actorId: string;
}>;

const WRONG_SCOPES: readonly (readonly [string, WrongScope])[] = [
  [
    'a malformed workspace',
    () => Promise.resolve({ workspaceId: 'not-a-uuid', actorId: userId }),
  ],
  [
    'a missing workspace',
    () => Promise.resolve({ workspaceId: '', actorId: userId }),
  ],
  [
    'a workspace that does not exist',
    () => Promise.resolve({ workspaceId: randomUUID(), actorId: userId }),
  ],
  [
    'a malformed actor',
    (workspaceId) => Promise.resolve({ workspaceId, actorId: 'not-a-uuid' }),
  ],
  [
    'a missing actor',
    (workspaceId) => Promise.resolve({ workspaceId, actorId: '' }),
  ],
  [
    'an actor who does not exist',
    (workspaceId) => Promise.resolve({ workspaceId, actorId: randomUUID() }),
  ],
  [
    'an actor of another workspace',
    async (workspaceId) => ({
      workspaceId,
      actorId: await member((await fixture()).workspaceId, 'admin'),
    }),
  ],
];

describe.each(MODES)('in %s mode', (mode) => {
  it.each(WRONG_SCOPES)(
    '%s is refused before the operation runs, and nothing is written',
    async (_kind, wrongScope) => {
      const { workspaceId } = await fixture();
      const before = await workspaceName(workspaceId);
      const operation = vi.fn(
        async (client: {
          query: (sql: string, values: unknown[]) => Promise<unknown>;
        }) => {
          await client.query(RENAME, [workspaceId]);
        },
      );
      await expect(
        withWorkspaceAccess(
          pool,
          await wrongScope(workspaceId),
          { mode, ...anyMember },
          operation,
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(operation).not.toHaveBeenCalled();
      expect(await workspaceName(workspaceId)).toBe(before);
    },
  );
});
