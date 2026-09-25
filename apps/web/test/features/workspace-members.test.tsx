import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  api,
  deferred,
  firstMemberId,
  identityHandlers,
  member,
  membersOf,
  noInvitations,
  ownerWorkspace,
  problem,
  rowOf,
  secondMemberId,
  timestamp,
  user,
  userId,
  workspace,
  workspaceId,
} from '../support/team-fixtures';

// Each page loads its lazy route on first render; under a busy machine that
// can outlast the default one-second wait without anything being wrong.

const invitationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function invitation(email: string, id = invitationId) {
  return {
    id,
    email,
    role: 'viewer',
    status: 'pending',
    revision: 1,
    deliveryStatus: 'queued',
    expiresAt: new Date(Date.now() + 6.5 * 86_400_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function sheet() {
  return document.querySelector<HTMLElement>('[data-slot="sheet-content"]');
}

function lens() {
  const element = sheet();
  if (element === null) throw new Error('No lens is open.');
  return within(element);
}

function confirmation() {
  return screen.queryByRole('dialog', { name: /^Make /u });
}

async function pickRole(
  actor: ReturnType<typeof userEvent.setup>,
  name: string,
  role: string,
) {
  await actor.click(
    await screen.findByRole('combobox', { name: `Role for ${name}` }),
  );
  await actor.click(await screen.findByRole('option', { name: role }));
}

describe('team: invitations', () => {
  it('creates an invitation and retries an uncertain command with the exact body and key', async () => {
    const commandRequests: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
      noInvitations(),
      http.post(`${api}/invitations`, async ({ request }) => {
        commandRequests.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        if (commandRequests.length === 1) return HttpResponse.error();
        return HttpResponse.json(
          { invitation: invitation('new.member@example.test'), replayed: true },
          { status: 202 },
        );
      }),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`, { strict: true });
    await browser.click(
      await screen.findByRole('button', { name: 'Invite people' }),
    );
    await browser.type(
      lens().getByLabelText('Email addresses'),
      'new.member@example.test',
    );
    await browser.click(
      lens().getByRole('button', { name: 'Send invitation' }),
    );
    expect(await lens().findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether the invitation to new.member@example.test went through',
    );
    await browser.click(lens().getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(sheet()).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText('Invitation sent to new.member@example.test'),
    ).toBeVisible();
    expect(commandRequests).toHaveLength(2);
    expect(commandRequests[1]).toEqual(commandRequests[0]);
    expect(commandRequests[0]?.body).toEqual({
      email: 'new.member@example.test',
      role: 'viewer',
    });
    expect(commandRequests[0]?.key).toBeTruthy();
  });

  it('sends several invitations one by one and reports each address', async () => {
    const sent: unknown[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
      noInvitations(),
      http.post(`${api}/invitations`, async ({ request }) => {
        const body = (await request.json()) as { email: string };
        sent.push(body);
        if (body.email === 'taken@example.test')
          return problem(409, 'workspace.invitation_conflict');
        return HttpResponse.json(
          { invitation: invitation(body.email), replayed: false },
          { status: 202 },
        );
      }),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/team?invite=true`);
    const field = await screen.findByLabelText('Email addresses');
    await browser.type(field, 'first@example.test, nope ');
    expect(lens().getByText('first@example.test')).toBeVisible();
    expect(field).toHaveValue('nope');
    expect(field).toHaveAccessibleDescription(
      expect.stringContaining('“nope” isn’t a complete email address'),
    );
    await browser.clear(field);
    await browser.type(field, 'taken@example.test{Enter}');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    await browser.click(lens().getByRole('combobox', { name: 'Role' }));
    await browser.click(
      await screen.findByRole('option', { name: /^Operator/u }),
    );
    await browser.click(
      lens().getByRole('button', { name: 'Send 2 invitations' }),
    );

    const results = await lens().findByRole('list', {
      name: 'Invitation results',
    });
    await waitFor(() => {
      expect(
        within(results).getByText('first@example.test').closest('li'),
      ).toHaveTextContent('Sent');
    });
    expect(
      within(results).getByText('taken@example.test').closest('li'),
    ).toHaveTextContent(
      'taken@example.test already has a pending invitation or is a member.',
    );
    expect(sent).toEqual([
      { email: 'first@example.test', role: 'operator' },
      { email: 'taken@example.test', role: 'operator' },
    ]);
  });

  it('does not submit an invitation after the authenticated identity changes', async () => {
    let currentUser = user;
    let commands = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(currentUser),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [ownerWorkspace], nextCursor: null }),
      ),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
      noInvitations(),
      http.post(`${api}/invitations`, () => {
        commands += 1;
        return HttpResponse.error();
      }),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`);
    await browser.click(
      await screen.findByRole('button', { name: 'Invite people' }),
    );
    await browser.type(
      lens().getByLabelText('Email addresses'),
      'new.member@example.test',
    );
    currentUser = { ...user, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    await browser.click(
      lens().getByRole('button', { name: 'Send invitation' }),
    );
    expect(
      await screen.findByText('Your session is no longer available'),
    ).toBeVisible();
    expect(commands).toBe(0);
  });

  it('blocks an exact uncertain retry after the authenticated identity changes', async () => {
    let currentUser = user;
    let commands = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(currentUser),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [ownerWorkspace], nextCursor: null }),
      ),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
      noInvitations(),
      http.post(`${api}/invitations`, () => {
        commands += 1;
        return HttpResponse.error();
      }),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`, { strict: true });
    await browser.click(
      await screen.findByRole('button', { name: 'Invite people' }),
    );
    await browser.type(
      lens().getByLabelText('Email addresses'),
      'new.member@example.test',
    );
    await browser.click(
      lens().getByRole('button', { name: 'Send invitation' }),
    );
    expect(await lens().findByRole('alert')).toHaveTextContent(
      'couldn’t confirm',
    );
    currentUser = { ...user, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    await browser.click(lens().getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Your session is no longer available'),
    ).toBeVisible();
    expect(commands).toBe(1);
  });

  it('paginates invitations independently from members and puts delivery and expiry in words', async () => {
    const requestedCursors: (string | null)[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'owner')]),
      http.get(`${api}/invitations`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        requestedCursors.push(after);
        return HttpResponse.json({
          items: [
            after === null
              ? invitation('first.invite@example.test')
              : {
                  ...invitation(
                    'second.invite@example.test',
                    'ffffffff-ffff-4fff-8fff-ffffffffffff',
                  ),
                  deliveryStatus: 'failed',
                },
          ],
          nextCursor: after === null ? 'next-invitation-page' : null,
        });
      }),
    );

    renderApp(`/w/${workspaceId}/team?tab=invitations`, { strict: true });
    expect(await screen.findByText('first.invite@example.test')).toBeVisible();
    expect(screen.getByText('Sending · expires in 6 days')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more invitations' }));
    expect(await screen.findByText('second.invite@example.test')).toBeVisible();
    expect(screen.getByText('Couldn’t send · expires in 6 days')).toBeVisible();
    expect(
      requestedCursors.filter((cursor) => cursor === 'next-invitation-page'),
    ).toHaveLength(1);
    expect(requestedCursors.at(-1)).toBe('next-invitation-page');
  });

  it('revokes an invitation from its menu after confirming', async () => {
    const commands: unknown[] = [];
    let revoked = false;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'owner')]),
      http.get(`${api}/invitations`, () =>
        HttpResponse.json({
          items: [
            {
              ...invitation('first.invite@example.test'),
              status: revoked ? 'revoked' : 'pending',
            },
          ],
          nextCursor: null,
        }),
      ),
      http.post(
        `${api}/invitations/${invitationId}/revoke`,
        async ({ request }) => {
          commands.push(await request.json());
          revoked = true;
          return HttpResponse.json({
            invitation: {
              ...invitation('first.invite@example.test'),
              status: 'revoked',
              revision: 2,
            },
            replayed: false,
          });
        },
      ),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/team?tab=invitations`);
    await browser.click(
      await screen.findByRole('button', {
        name: 'Actions for first.invite@example.test',
      }),
    );
    await browser.click(
      await screen.findByRole('menuitem', { name: 'Revoke invitation' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke the invitation for first.invite@example.test?',
    });
    await browser.click(
      within(dialog).getByRole('button', { name: 'Revoke invitation' }),
    );
    expect(
      await screen.findByText(
        'Revoked the invitation for first.invite@example.test',
      ),
    ).toBeVisible();
    expect(commands).toEqual([{ expectedRevision: 1 }]);
    await waitFor(() => {
      expect(
        rowOf('first.invite@example.test').getByText('Revoked'),
      ).toBeVisible();
    });
  });
});

describe('team: members', () => {
  it('paginates safe member projections and shows the roles matrix', async () => {
    const requestedCursors: (string | null)[] = [];
    mockServer.use(
      ...identityHandlers(),
      http.get(`${api}/members`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        requestedCursors.push(query.get('after'));
        expect(query.get('limit')).toBe('50');
        return HttpResponse.json(
          query.get('after') === null
            ? {
                items: [
                  member(
                    userId,
                    'A member with a display name long enough to need truncation in narrow layouts',
                    'viewer',
                  ),
                ],
                nextCursor: 'next-page',
              }
            : {
                items: [member(secondMemberId, 'Second Member', 'viewer')],
                nextCursor: null,
              },
        );
      }),
    );

    renderApp(`/w/${workspaceId}/team`, { strict: true });
    expect(
      await screen.findByText(
        'A member with a display name long enough to need truncation in narrow layouts',
      ),
    ).toBeVisible();
    expect(screen.getByText('you')).toBeVisible();
    const matrix = screen.getByRole('table');
    expect(
      within(matrix).getByRole('rowheader', {
        name: 'Rename or delete the workspace',
      }),
    ).toBeVisible();
    // Full role names name every column; phones show whole short words.
    expect(
      within(matrix)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Ability',
      'OwnerOwner',
      'AdminAdmin',
      'BuildBuilder',
      'OpsOperator',
      'ViewViewer',
    ]);
    expect(
      within(matrix).getByRole('columnheader', { name: 'Operator' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('You’re a Viewer. Your column is highlighted.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('tab', { name: /Invitations/u }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second Member')).toBeVisible();
    expect(requestedCursors).toEqual([null, 'next-page']);
  });

  it('does not request or advertise members without read capability', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers({ ...workspace, capabilities: ['workspace:read'] }),
      http.get(`${api}/members`, () => {
        reads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderApp(`/w/${workspaceId}/team`);
    expect(
      await screen.findByRole('heading', {
        name: 'Workspace members are unavailable',
      }),
    ).toBeVisible();
    expect(reads).toBe(0);
  });

  it('keeps a failed read distinct from an empty member list', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(`${api}/members`, () => HttpResponse.error()),
    );
    renderApp(`/w/${workspaceId}/team`);
    expect(
      await screen.findByRole('heading', {
        name: 'Members couldn’t be loaded',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'No members to show' }),
    ).not.toBeInTheDocument();
  });

  it('shows an empty directory only after a successful read', async () => {
    mockServer.use(
      ...identityHandlers(),
      membersOf(() => []),
    );
    renderApp(`/w/${workspaceId}/team`);
    expect(
      await screen.findByRole('heading', { name: 'No members to show' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Members couldn’t be loaded' }),
    ).not.toBeInTheDocument();
  });

  it('keeps loaded members visible when the next page fails', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(`${api}/members`, ({ request }) =>
        new URL(request.url).searchParams.get('after') === null
          ? HttpResponse.json({
              items: [member(firstMemberId, 'Ada Operator', 'owner')],
              nextCursor: 'next-page',
            })
          : HttpResponse.error(),
      ),
    );
    renderApp(`/w/${workspaceId}/team`);
    expect(await screen.findByText('Ada Operator')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'More members couldn’t be loaded. The ones above are unchanged.',
    );
    expect(screen.getByText('Ada Operator')).toBeVisible();
  });

  it('keeps cached members visible through a failed refresh and recovers', async () => {
    let fail = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(`${api}/members`, () =>
        fail
          ? HttpResponse.error()
          : HttpResponse.json({
              items: [member(firstMemberId, 'Ada Operator', 'owner')],
              nextCursor: null,
            }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/team`);
    expect(await screen.findByText('Ada Operator')).toBeVisible();
    fail = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'members'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn’t refresh. Showing results from/u,
    );
    expect(screen.getByText('Ada Operator')).toBeVisible();
    fail = false;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('hides cached members after permission is lost', async () => {
    let denied = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(`${api}/members`, () =>
        denied
          ? problem(403, 'auth.forbidden')
          : HttpResponse.json({
              items: [member(firstMemberId, 'Ada Operator', 'owner')],
              nextCursor: null,
            }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/team`);
    expect(await screen.findByText('Ada Operator')).toBeVisible();
    denied = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'members'],
    });
    expect(
      await screen.findByRole('heading', { name: 'Member access was removed' }),
    ).toBeVisible();
    expect(screen.queryByText('Ada Operator')).not.toBeInTheDocument();
  });

  it('removes cached members and an open confirmation after authentication is lost', async () => {
    let sessionExpired = false;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      http.get(`${api}/members`, () =>
        sessionExpired
          ? problem(401, 'auth.unauthenticated')
          : HttpResponse.json({
              items: [member(firstMemberId, 'Alice Member', 'viewer')],
              nextCursor: null,
            }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/team`);
    await pickRole(userEvent.setup(), 'Alice Member', 'Operator');
    expect(confirmation()).toHaveTextContent('Alice Member');

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
    expect(confirmation()).not.toBeInTheDocument();
  });

  it('removes protected state after a role command reports authentication loss without replaying', async () => {
    let commandCount = 0;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      membersOf(() => [member(firstMemberId, 'Alice Member', 'viewer')]),
      http.post(`${api}/members/${firstMemberId}/role`, () => {
        commandCount += 1;
        return problem(401, 'auth.unauthenticated');
      }),
    );
    const browser = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`, { strict: true });
    await pickRole(browser, 'Alice Member', 'Operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Your session is no longer available',
      }),
    ).toBeVisible();
    expect(screen.queryByText('Alice Member')).not.toBeInTheDocument();
    expect(confirmation()).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commandCount).toBe(1);
  });

  it('keeps the exact role command available after an uncertain response', async () => {
    const commands: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
      http.post(`${api}/members/${firstMemberId}/role`, async ({ request }) => {
        commands.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        return commands.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({
              userId: firstMemberId,
              role: 'operator',
              roleRevision: 2,
              changed: true,
              replayed: true,
            });
      }),
    );

    renderApp(`/w/${workspaceId}/team`, { strict: true });
    const browser = userEvent.setup();
    await pickRole(browser, 'Ada Operator', 'Operator');
    expect(confirmation()).toHaveTextContent('signed out everywhere');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether Ada Operator’s role changed',
    );
    await browser.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.body).toEqual({
      role: 'operator',
      expectedRoleRevision: 1,
    });
    await waitFor(() => {
      expect(confirmation()).not.toBeInTheDocument();
    });
  });

  it('keeps an in-flight and uncertain command attached to its original member', async () => {
    const firstResponse = deferred<Response>();
    const commands: { target: string; key: string | null; body: unknown }[] =
      [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      membersOf(() => [
        member(firstMemberId, 'Alice Member', 'viewer'),
        member(secondMemberId, 'Bob Member', 'builder'),
      ]),
      http.post(
        `${api}/members/:targetUserId/role`,
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

    renderApp(`/w/${workspaceId}/team`, { strict: true });
    const browser = userEvent.setup();
    await pickRole(browser, 'Alice Member', 'Operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await browser.keyboard('{Escape}');
    expect(confirmation()).toHaveTextContent('Alice Member');
    expect(
      rowOf('Bob Member').getByRole('combobox', { hidden: true }),
    ).toHaveAttribute('data-disabled');

    firstResponse.resolve(Response.error());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Alice Member’s role changed',
    );
    expect(confirmation()).toHaveTextContent('Alice Member');
    expect(confirmation()).not.toHaveTextContent('Bob Member');
    await browser.keyboard('{Escape}');
    expect(confirmation()).toHaveTextContent('Alice Member');

    await browser.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(commands).toHaveLength(2);
    });
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      target: firstMemberId,
      body: { role: 'operator', expectedRoleRevision: 1 },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'couldn’t confirm',
    );

    await browser.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(confirmation()).not.toBeInTheDocument();
    });
    await pickRole(browser, 'Bob Member', 'Viewer');
    expect(confirmation()).toHaveTextContent('Bob Member');
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

  it('keeps the confirmation locked through authoritative refresh reconciliation', async () => {
    const refreshedMembers = deferred<Response>();
    let reads = 0;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      http.get(`${api}/members`, () => {
        reads += 1;
        return reads === 1
          ? HttpResponse.json({
              items: [member(firstMemberId, 'Alice Member', 'viewer')],
              nextCursor: null,
            })
          : refreshedMembers.promise;
      }),
      http.post(`${api}/members/${firstMemberId}/role`, () =>
        HttpResponse.json({
          userId: firstMemberId,
          role: 'operator',
          roleRevision: 2,
          changed: true,
          replayed: false,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/team`);
    const browser = userEvent.setup();
    await pickRole(browser, 'Alice Member', 'Operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await browser.keyboard('{Escape}');
    expect(confirmation()).toHaveTextContent('Alice Member');

    refreshedMembers.resolve(
      Response.json({
        items: [member(firstMemberId, 'Alice Member', 'operator', 2)],
        nextCursor: null,
      }),
    );
    await waitFor(() => {
      expect(confirmation()).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText('Alice Member is now an Operator'),
    ).toBeVisible();
    expect(rowOf('Alice Member').getByRole('combobox')).toHaveTextContent(
      'Operator',
    );
  });

  it('fences reconciliation callbacks after the team route is disposed', async () => {
    const refreshedMembers = deferred<Response>();
    let reads = 0;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      http.get(`${api}/members`, () => {
        reads += 1;
        return reads === 1
          ? HttpResponse.json({
              items: [member(firstMemberId, 'Alice Member', 'viewer')],
              nextCursor: null,
            })
          : refreshedMembers.promise;
      }),
      http.post(`${api}/members/${firstMemberId}/role`, () =>
        HttpResponse.json({
          userId: firstMemberId,
          role: 'operator',
          roleRevision: 2,
          changed: true,
          replayed: false,
        }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/team`, { strict: true });
    const browser = userEvent.setup();
    await pickRole(browser, 'Alice Member', 'Operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(reads).toBe(2);
    });

    await router.navigate({ to: '/workspaces' });
    expect(
      await screen.findByRole('heading', { name: 'Workspaces' }),
    ).toBeVisible();
    refreshedMembers.resolve(
      Response.json({
        items: [member(firstMemberId, 'Alice Member', 'operator', 2)],
        nextCursor: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.state.location.pathname).toBe('/workspaces');
    expect(confirmation()).not.toBeInTheDocument();
  });

  it('does not offer self, owner, or admin-managed admin role changes', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'admin',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      noInvitations(),
      membersOf(() => [
        member(userId, 'Current Admin', 'viewer'),
        member(firstMemberId, 'Workspace Owner', 'owner'),
        member(secondMemberId, 'Another Admin', 'admin'),
      ]),
    );
    renderApp(`/w/${workspaceId}/team`);
    await screen.findByText('Another Admin');
    expect(
      screen.queryByRole('combobox', { name: /^Role for/u }),
    ).not.toBeInTheDocument();
    expect(rowOf('Workspace Owner').getByText('Owner')).toBeVisible();
  });

  it('lets an admin manage delegated roles without exposing admin or owner promotion', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'admin',
        capabilities: ['workspace:read', 'member:read', 'member:manage'],
      }),
      noInvitations(),
      membersOf(() => [member(firstMemberId, 'Builder Member', 'builder')]),
    );
    renderApp(`/w/${workspaceId}/team`);
    await userEvent.setup().click(
      await screen.findByRole('combobox', {
        name: 'Role for Builder Member',
      }),
    );
    const choices = (await screen.findAllByRole('option')).map(
      (option) => option.textContent,
    );
    expect(choices).toEqual(['Builder', 'Operator', 'Viewer']);
  });

  it('refreshes a stale revision and requires an explicit new confirmation', async () => {
    let revision = 1;
    const commands: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      membersOf(() => [
        member(firstMemberId, 'Ada Operator', 'viewer', revision),
      ]),
      http.post(`${api}/members/${firstMemberId}/role`, async ({ request }) => {
        commands.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        if (commands.length === 1) {
          revision = 2;
          return problem(409, 'workspace.member_role_revision_conflict');
        }
        return HttpResponse.json({
          userId: firstMemberId,
          role: 'operator',
          roleRevision: 3,
          changed: true,
          replayed: false,
        });
      }),
    );
    renderApp(`/w/${workspaceId}/team`);
    const browser = userEvent.setup();
    await pickRole(browser, 'Ada Operator', 'Operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(confirmation()).not.toBeInTheDocument();
    });
    expect(await rowOf('Ada Operator').findByRole('alert')).toHaveTextContent(
      'Ada Operator’s role changed while you were deciding',
    );
    await pickRole(browser, 'Ada Operator', 'Operator');
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
