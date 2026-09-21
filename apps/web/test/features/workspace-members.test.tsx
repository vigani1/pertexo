import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const firstMemberId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secondMemberId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const timestamp = '2026-09-15T10:00:00.000Z';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workspace = {
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

function member(
  userIdValue: string,
  displayName: string,
  role: 'owner' | 'admin' | 'builder' | 'operator' | 'viewer',
) {
  return {
    userId: userIdValue,
    email: `${userIdValue.slice(0, 8)}@example.test`,
    displayName,
    role,
    roleRevision: 1,
    membershipStatus: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

function forbidden() {
  return HttpResponse.json(
    {
      type: 'https://pertexo.test/problems/auth.forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'auth.forbidden',
      requestId: 'request-members-forbidden',
    },
    { status: 403, headers: { 'content-type': 'application/problem+json' } },
  );
}

function unauthenticated() {
  return HttpResponse.json(
    {
      type: 'https://pertexo.test/problems/auth.unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'request-members-unauthenticated',
    },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve } as const;
}

describe('workspace members', () => {
  it('creates an invitation and retries an uncertain command with the exact body and key', async () => {
    const commandRequests: { body: unknown; key: string | null }[] = [];
    let attempt = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [member(firstMemberId, 'Ada Operator', 'viewer')],
          nextCursor: null,
        }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/invitations`,
        () => HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/invitations`,
        async ({ request }) => {
          commandRequests.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          attempt += 1;
          if (attempt === 1) return HttpResponse.error();
          return HttpResponse.json(
            {
              invitation: {
                id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                email: 'new.member@example.test',
                role: 'viewer',
                status: 'pending',
                revision: 1,
                deliveryStatus: 'queued',
                expiresAt: '2026-09-22T10:00:00.000Z',
                createdAt: timestamp,
                updatedAt: timestamp,
              },
              replayed: true,
            },
            { status: 202 },
          );
        },
      ),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/settings/members`, { strict: true });
    await browser.click(
      await screen.findByRole('button', { name: 'Invite member' }),
    );
    await browser.type(
      screen.getByLabelText('Recipient email'),
      'new.member@example.test',
    );
    await browser.click(
      screen.getByRole('button', { name: 'Send invitation' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'result is uncertain',
    );
    await browser.click(
      screen.getByRole('button', { name: 'Retry same invitation' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(commandRequests).toHaveLength(2);
    expect(commandRequests[1]).toEqual(commandRequests[0]);
    expect(commandRequests[0]?.body).toEqual({
      email: 'new.member@example.test',
      role: 'viewer',
    });
    expect(commandRequests[0]?.key).toBeTruthy();
  });

  it('paginates pending invitations independently from members', async () => {
    const requestedCursors: (string | null)[] = [];
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [member(firstMemberId, 'Ada Operator', 'owner')],
          nextCursor: null,
        }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/invitations`,
        ({ request }) => {
          const after = new URL(request.url).searchParams.get('after');
          requestedCursors.push(after);
          return HttpResponse.json({
            items: [
              {
                id:
                  after === null
                    ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
                    : 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                email:
                  after === null
                    ? 'first.invite@example.test'
                    : 'second.invite@example.test',
                role: 'viewer',
                status: 'pending',
                revision: 1,
                deliveryStatus: 'queued',
                expiresAt: '2026-09-22T10:00:00.000Z',
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            nextCursor: after === null ? 'next-invitation-page' : null,
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`, { strict: true });
    expect(await screen.findByText('first.invite@example.test')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more invitations' }));
    expect(await screen.findByText('second.invite@example.test')).toBeVisible();
    expect(requestedCursors).toContain(null);
    expect(
      requestedCursors.filter((cursor) => cursor === 'next-invitation-page'),
    ).toHaveLength(1);
    expect(requestedCursors.at(-1)).toBe('next-invitation-page');
  });

  it('paginates safe member projections in StrictMode', async () => {
    const requestedCursors: (string | null)[] = [];
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        ({ request }) => {
          const query = new URL(request.url).searchParams;
          requestedCursors.push(query.get('after'));
          expect(query.get('limit')).toBe('50');
          return HttpResponse.json(
            query.get('after') === null
              ? {
                  items: [
                    member(
                      firstMemberId,
                      'A member with a display name long enough to need truncation in narrow layouts',
                      'owner',
                    ),
                  ],
                  nextCursor: 'next-page',
                }
              : {
                  items: [member(secondMemberId, 'Second Member', 'viewer')],
                  nextCursor: null,
                },
          );
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`, { strict: true });
    expect(
      await screen.findByText(
        'A member with a display name long enough to need truncation in narrow layouts',
      ),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second Member')).toBeVisible();
    expect(requestedCursors).toEqual([null, 'next-page']);
  });

  it('does not request or advertise members without read capability', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: ['workspace:read'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        () => {
          reads += 1;
          return HttpResponse.json({ items: [], nextCursor: null });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`);
    expect(
      await screen.findByRole('heading', {
        name: 'Workspace members are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Workspace settings' }),
    ).not.toBeInTheDocument();
    expect(reads).toBe(0);
  });

  it('keeps a failed read distinct from an empty member list', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.error(),
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`);
    expect(
      await screen.findByRole('heading', {
        name: 'Workspace members could not be loaded',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'No workspace members' }),
    ).not.toBeInTheDocument();
  });

  it('shows an empty directory only after a successful read', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`);
    expect(
      await screen.findByRole('heading', { name: 'No workspace members' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', {
        name: 'Workspace members could not be loaded',
      }),
    ).not.toBeInTheDocument();
  });

  it('keeps loaded members visible when the next page fails', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        ({ request }) =>
          new URL(request.url).searchParams.get('after') === null
            ? HttpResponse.json({
                items: [member(firstMemberId, 'Ada Operator', 'owner')],
                nextCursor: 'next-page',
              })
            : HttpResponse.error(),
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`);
    expect(await screen.findByText('Ada Operator')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The next member page could not be loaded. Try again.',
    );
    expect(screen.getByText('Ada Operator')).toBeVisible();
  });

  it('keeps cached members visible through a failed refresh and recovers', async () => {
    let fail = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        () =>
          fail
            ? HttpResponse.error()
            : HttpResponse.json({
                items: [member(firstMemberId, 'Ada Operator', 'owner')],
                nextCursor: null,
              }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/settings/members`);
    expect(await screen.findByText('Ada Operator')).toBeVisible();
    fail = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'members'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These members may be stale',
    );
    expect(screen.getByText('Ada Operator')).toBeVisible();
    fail = false;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('hides cached members and settings actions after permission is lost', async () => {
    let denied = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        () =>
          denied
            ? forbidden()
            : HttpResponse.json({
                items: [member(firstMemberId, 'Ada Operator', 'owner')],
                nextCursor: null,
              }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/settings/members`);
    expect(await screen.findByText('Ada Operator')).toBeVisible();
    denied = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'members'],
    });
    expect(
      await screen.findByRole('heading', { name: 'Member access was removed' }),
    ).toBeVisible();
    expect(screen.queryByText('Ada Operator')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('removes cached members and an open confirmation after authentication is lost', async () => {
    let sessionExpired = false;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        () =>
          sessionExpired
            ? unauthenticated()
            : HttpResponse.json({
                items: [member(firstMemberId, 'Alice Member', 'viewer')],
                nextCursor: null,
              }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/settings/members`);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Change role' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Alice Member');

    sessionExpired = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'members'],
    });

    expect(
      await screen.findByRole('heading', {
        name: 'Your session is no longer available',
      }),
    ).toBeVisible();
    expect(screen.queryByText('Alice Member')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change role' }),
    ).not.toBeInTheDocument();
  });

  it('removes protected state after a role command reports authentication loss without replaying', async () => {
    let commandCount = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [member(firstMemberId, 'Alice Member', 'viewer')],
          nextCursor: null,
        }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members/${firstMemberId}/role`,
        () => {
          commandCount += 1;
          return unauthenticated();
        },
      ),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/settings/members`, { strict: true });
    await browser.click(
      await screen.findByRole('button', { name: 'Change role' }),
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));

    expect(
      await screen.findByRole('heading', {
        name: 'Your session is no longer available',
      }),
    ).toBeVisible();
    expect(screen.queryByText('Alice Member')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commandCount).toBe(1);
  });

  it('keeps the exact role command available after an uncertain response', async () => {
    const commands: { key: string | null; body: unknown }[] = [];
    let attempt = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [member(firstMemberId, 'Ada Operator', 'viewer')],
          nextCursor: null,
        }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members/${firstMemberId}/role`,
        async ({ request }) => {
          commands.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          attempt += 1;
          return attempt === 1
            ? HttpResponse.error()
            : HttpResponse.json({
                userId: firstMemberId,
                role: 'operator',
                roleRevision: 2,
                changed: true,
                replayed: true,
              });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`, { strict: true });
    const browser = userEvent.setup();
    await browser.click(
      await screen.findByRole('button', { name: 'Change role' }),
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'result is uncertain',
    );
    await browser.click(
      screen.getByRole('button', { name: 'Retry same change' }),
    );
    await waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.body).toEqual({
      role: 'operator',
      expectedRoleRevision: 1,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps an in-flight and uncertain command attached to its original member', async () => {
    const firstResponse = deferred<Response>();
    const commands: {
      target: string;
      key: string | null;
      body: unknown;
    }[] = [];
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [
            member(firstMemberId, 'Alice Member', 'viewer'),
            member(secondMemberId, 'Bob Member', 'builder'),
          ],
          nextCursor: null,
        }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members/:targetUserId/role`,
        async ({ params, request }) => {
          commands.push({
            target: String(params.targetUserId),
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          if (commands.length === 1) return firstResponse.promise;
          if (commands.length === 2) return HttpResponse.error();
          return HttpResponse.json({
            userId: secondMemberId,
            role: 'viewer',
            roleRevision: 2,
            changed: true,
            replayed: false,
          });
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings/members`, { strict: true });
    const browser = userEvent.setup();
    const aliceRow = (await screen.findByText('Alice Member')).closest('tr');
    if (aliceRow === null) throw new Error('Alice row is unavailable');
    await browser.click(
      within(aliceRow).getByRole('button', { name: 'Change role' }),
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await browser.keyboard('{Escape}');
    await browser.click(document.body);
    expect(screen.getByRole('dialog')).toHaveTextContent('Alice Member');
    const bobRow = screen.getByText('Bob Member').closest('tr');
    if (bobRow === null) throw new Error('Bob row is unavailable');
    const disabledBobAction = within(bobRow).getByRole('button', {
      name: 'Change role',
      hidden: true,
    });
    expect(disabledBobAction).toBeDisabled();
    disabledBobAction.click();
    expect(screen.getByRole('dialog')).toHaveTextContent('Alice Member');

    firstResponse.resolve(Response.error());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'result is uncertain',
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Alice Member');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Bob Member');
    await browser.keyboard('{Escape}');
    await browser.click(document.body);
    expect(screen.getByRole('dialog')).toHaveTextContent('Alice Member');

    await browser.click(
      screen.getByRole('button', { name: 'Retry same change' }),
    );
    await waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      target: firstMemberId,
      body: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'result is uncertain',
    );

    await browser.click(
      screen.getByRole('button', { name: 'Dismiss attempt' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const currentBobRow = screen.getByText('Bob Member').closest('tr');
    if (currentBobRow === null) throw new Error('Bob row is unavailable');
    await browser.click(
      within(currentBobRow).getByRole('button', { name: 'Change role' }),
    );
    expect(screen.getByRole('dialog')).toHaveTextContent('Bob Member');
    await browser.selectOptions(screen.getByLabelText('New role'), 'viewer');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(commands).toHaveLength(3);
    });
    expect(commands[2]).toMatchObject({
      target: secondMemberId,
      body: { role: 'viewer', expectedRoleRevision: 1 },
    });
    expect(commands[2]?.key).not.toBe(commands[0]?.key);
  });

  it('keeps the dialog locked through authoritative refresh reconciliation', async () => {
    const refreshedMembers = deferred<Response>();
    let reads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        () => {
          reads += 1;
          return reads === 1
            ? HttpResponse.json({
                items: [member(firstMemberId, 'Alice Member', 'viewer')],
                nextCursor: null,
              })
            : refreshedMembers.promise;
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members/${firstMemberId}/role`,
        () =>
          HttpResponse.json({
            userId: firstMemberId,
            role: 'operator',
            roleRevision: 2,
            changed: true,
            replayed: false,
          }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings/members`);
    const browser = userEvent.setup();
    await browser.click(
      await screen.findByRole('button', { name: 'Change role' }),
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await browser.keyboard('{Escape}');
    await browser.click(document.body);
    expect(screen.getByRole('dialog')).toHaveTextContent('Alice Member');

    refreshedMembers.resolve(
      Response.json({
        items: [
          {
            ...member(firstMemberId, 'Alice Member', 'operator'),
            roleRevision: 2,
          },
        ],
        nextCursor: null,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    const aliceRow = screen.getByText('Alice Member').closest('tr');
    if (aliceRow === null) throw new Error('Alice row is unavailable');
    expect(within(aliceRow).getByText('operator')).toBeVisible();
  });

  it('fences reconciliation callbacks after the members route is disposed', async () => {
    const refreshedMembers = deferred<Response>();
    let reads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members`,
        () => {
          reads += 1;
          return reads === 1
            ? HttpResponse.json({
                items: [member(firstMemberId, 'Alice Member', 'viewer')],
                nextCursor: null,
              })
            : refreshedMembers.promise;
        },
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members/${firstMemberId}/role`,
        () =>
          HttpResponse.json({
            userId: firstMemberId,
            role: 'operator',
            roleRevision: 2,
            changed: true,
            replayed: false,
          }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/settings/members`, {
      strict: true,
    });
    const browser = userEvent.setup();
    await browser.click(
      await screen.findByRole('button', { name: 'Change role' }),
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    await router.navigate({ to: '/workspaces' });
    expect(await screen.findByText('Choose your workspace')).toBeVisible();
    refreshedMembers.resolve(
      Response.json({
        items: [
          {
            ...member(firstMemberId, 'Alice Member', 'operator'),
            roleRevision: 2,
          },
        ],
        nextCursor: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe('/workspaces');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not offer self, owner, or admin-managed admin role changes', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'admin',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [
            member(userId, 'Current Admin', 'viewer'),
            member(firstMemberId, 'Workspace Owner', 'owner'),
            {
              ...member(secondMemberId, 'Another Admin', 'viewer'),
              role: 'admin',
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings/members`);
    await screen.findByText('Another Admin');
    expect(
      screen.queryByRole('button', { name: 'Change role' }),
    ).not.toBeInTheDocument();
  });

  it('lets an admin manage delegated roles without exposing admin or owner promotion', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'admin',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [member(firstMemberId, 'Builder Member', 'builder')],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings/members`);
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Change role' }));
    const choices = screen
      .getAllByRole('option')
      .map((option) => option.getAttribute('value'));
    expect(choices).toEqual(['builder', 'operator', 'viewer']);
  });

  it('refreshes a stale revision and requires an explicit new confirmation', async () => {
    let revision = 1;
    const commands: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'owner',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          items: [
            {
              ...member(firstMemberId, 'Ada Operator', 'viewer'),
              roleRevision: revision,
            },
          ],
          nextCursor: null,
        }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/members/${firstMemberId}/role`,
        async ({ request }) => {
          commands.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          if (commands.length === 1) {
            revision = 2;
            return HttpResponse.json(
              {
                type: 'urn:pertexo:problem:workspace.member_role_revision_conflict',
                title: 'Workspace member role changed',
                status: 409,
                code: 'workspace.member_role_revision_conflict',
                requestId: 'request-role-conflict',
              },
              {
                status: 409,
                headers: { 'content-type': 'application/problem+json' },
              },
            );
          }
          return HttpResponse.json({
            userId: firstMemberId,
            role: 'operator',
            roleRevision: 3,
            changed: true,
            replayed: false,
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings/members`);
    const browser = userEvent.setup();
    await browser.click(
      await screen.findByRole('button', { name: 'Change role' }),
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'changed since you opened',
    );
    await browser.selectOptions(screen.getByLabelText('New role'), 'operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    expect(commands[0]?.body).toEqual({
      role: 'operator',
      expectedRoleRevision: 1,
    });
    expect(commands[1]?.body).toEqual({
      role: 'operator',
      expectedRoleRevision: 2,
    });
    expect(commands[1]?.key).not.toBe(commands[0]?.key);
  });
});
