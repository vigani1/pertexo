import { vi } from 'vitest';

import { createActorContext } from '../../../src/authorization/index.js';

import type { WorkspaceAccess } from '../../../src/authorization/index.js';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const requestId = 'request-42';

export const idempotencyKey = 'workspace-command-42';

export function workspace() {
  return {
    id: workspaceId,
    name: 'Operations',
    slug: 'operations',
    status: 'active' as const,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

function operation(
  commandType:
    | 'deletion_requested'
    | 'deletion_restored'
    | 'reactivated' = 'deletion_requested',
) {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    workspaceId,
    commandType,
    submittedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

export function user() {
  return {
    id: actorId,
    email: 'person@example.test',
    displayName: 'Person',
    status: 'active' as const,
    profileRevision: 3,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

export function persistence() {
  return {
    findUserById: vi.fn(),
    listAccessibleWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
    listWorkspaceMembers: vi.fn().mockResolvedValue({ items: [] }),
    changeWorkspaceMemberRole: vi.fn().mockResolvedValue({
      userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      role: 'operator',
      roleRevision: 2,
      changed: true,
      replayed: false,
    }),
    createWorkspaceWithOwner: vi.fn().mockResolvedValue(workspace()),
    requestWorkspaceLifecycleOperation: vi
      .fn()
      .mockImplementation(
        (input: {
          commandType:
            'deletion_requested' | 'deletion_restored' | 'reactivated';
        }) => Promise.resolve(operation(input.commandType)),
      ),
  };
}

export function activeAccess(
  role: WorkspaceAccess['role'] = 'owner',
  workspaceStatus: WorkspaceAccess['workspaceStatus'] = 'active',
): WorkspaceAccess {
  return {
    actorId,
    workspaceId,
    role,
    membershipStatus: 'active',
    workspaceStatus,
  };
}

export function actor() {
  return createActorContext({
    actorId,
    workspaceId,
    sessionId,
    requestId,
    traceId: 'trace-42',
  });
}
