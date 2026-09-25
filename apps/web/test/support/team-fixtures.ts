import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';

// Shared Team page fixtures: the signed-in person, their workspace, member
// rows and the mock handlers the member and removal suites both need.

export const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const firstMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const secondMemberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const timestamp = '2026-09-15T10:00:00.000Z';
export const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
export const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const workspace = {
  id: workspaceId,
  name: 'Control Operations With A Deliberately Long Workspace Name',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'viewer',
  capabilities: ['workspace:read', 'member:read'],
  createdAt: timestamp,
  updatedAt: timestamp,
};
export const ownerWorkspace = {
  ...workspace,
  role: 'owner',
  capabilities: ['workspace:read', 'member:read', 'member:manage'],
};

type Role = 'owner' | 'admin' | 'builder' | 'operator' | 'viewer';

export function member(
  userIdValue: string,
  displayName: string,
  role: Role,
  roleRevision = 1,
) {
  return {
    userId: userIdValue,
    email: `${userIdValue.slice(0, 8)}@example.test`,
    displayName,
    role,
    roleRevision,
    membershipStatus: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

export function membersOf(items: () => readonly unknown[]) {
  return http.get(`${api}/members`, () =>
    HttpResponse.json({ items: items(), nextCursor: null }),
  );
}

export function noInvitations() {
  return http.get(`${api}/invitations`, () =>
    HttpResponse.json({ items: [], nextCursor: null }),
  );
}

export function problem(status: number, code: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title: 'Problem',
      status,
      code,
      requestId: `request-${code}`,
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve } as const;
}

export function rowOf(name: string) {
  const row = screen.getByText(name).closest('li');
  if (row === null) throw new Error(`${name} row is unavailable`);
  return within(row);
}

/** A member command the handler saw: its key, body and path. */
export type SentMemberCommand = Readonly<{
  key: string | null;
  body: unknown;
  url: string;
}>;

/** Records each POST to one member command verb and answers it. */
export function memberCommandHandler(
  verb: string,
  sent: SentMemberCommand[],
  answer: (attempt: number) => Response,
) {
  return http.post(`${api}/members/:userId/${verb}`, async ({ request }) => {
    sent.push({
      key: request.headers.get('idempotency-key'),
      body: await request.json(),
      url: new URL(request.url).pathname,
    });
    return answer(sent.length);
  });
}
