import { HttpResponse, http } from 'msw';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../../support/fixtures/identity';
export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const timestamp = '2026-09-15T10:00:00.000Z';

export const user = createUserFixture({
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const workspace = createWorkspaceFixture({
  id: workspaceId,
  capabilities: ['workspace:read', 'workspace:manage', 'member:read'],
  createdAt: timestamp,
  updatedAt: timestamp,
});

export function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

export function lifecycleChange(
  change: 'deletion_requested' | 'deletion_restored' = 'deletion_requested',
) {
  return { workspaceId, change, occurredAt: timestamp };
}

export const scheduledForDeletion =
  'The workspace is scheduled for deletion. Restore it within 30 days of the request to keep it.';

export function problem(status: number, code: string, title: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title,
      status,
      code,
      requestId: 'workspace-rename-test',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function renameResponse(current: typeof workspace, replayed: boolean) {
  return {
    workspace: {
      id: current.id,
      name: current.name,
      slug: current.slug,
      status: current.status,
      revision: current.revision,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
    },
    changed: true,
    replayed,
  };
}
