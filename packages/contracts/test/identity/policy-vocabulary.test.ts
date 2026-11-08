import {
  ALL_WORKSPACE_STATUSES,
  AUTHORIZATION_CAPABILITIES,
  DISCOVERABLE_WORKSPACE_STATUSES,
} from '@pertexo/policy';
import { describe, expect, it } from 'vitest';

import {
  accessibleWorkspaceSchema,
  workspaceResponseSchema,
} from '../../src/schemas/identity/workspaces.js';

const workspace = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Operations',
  slug: 'operations',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:00.000Z',
};

describe('workspace transport uses the policy vocabulary', () => {
  it.each(ALL_WORKSPACE_STATUSES)(
    'can represent the owned %s status',
    (status) => {
      expect(
        workspaceResponseSchema.parse({ ...workspace, status }).status,
      ).toBe(status);
    },
  );
  it.each(ALL_WORKSPACE_STATUSES)(
    'offers %s only when policy calls it discoverable',
    (status) => {
      const discoverable = new Set<string>(DISCOVERABLE_WORKSPACE_STATUSES);
      expect(
        accessibleWorkspaceSchema.safeParse({
          ...workspace,
          status,
          revision: 1,
          role: 'owner',
          capabilities: [],
        }).success,
      ).toBe(discoverable.has(status));
    },
  );
  it.each(AUTHORIZATION_CAPABILITIES)(
    'can represent the owned %s grant',
    (capability) => {
      expect(
        accessibleWorkspaceSchema.parse({
          ...workspace,
          status: 'active',
          revision: 1,
          role: 'owner',
          capabilities: [capability],
        }).capabilities,
      ).toEqual([capability]);
    },
  );
  it('refuses statuses and grants outside the policy vocabulary', () => {
    expect(
      workspaceResponseSchema.safeParse({ ...workspace, status: 'unknown' })
        .success,
    ).toBe(false);
    expect(
      accessibleWorkspaceSchema.safeParse({
        ...workspace,
        status: 'active',
        revision: 1,
        role: 'owner',
        capabilities: ['workflow:delete'],
      }).success,
    ).toBe(false);
  });
});
