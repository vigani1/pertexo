import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import {
  api,
  firstMemberId,
  identityHandlers,
  member,
  membersOf,
  noInvitations,
  ownerWorkspace,
  problem,
  rowOf,
  secondMemberId,
  userId,
  workspace,
  workspaceId,
} from '../../../support/fixtures/team';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { confirmation, invitation, invitationId, pickRole } from './fixture';

describe('team: invitations', () => {
  it('revokes an invitation from its menu after confirming', async () => {
    const commands: unknown[] = [];
    let revoked = false;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'owner')]),
      http.get(`${api}/invitations`, () =>
        HttpResponse.json({
          issuanceAvailable: true,
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
        name: 'Rename, delete or hand over the workspace',
      }),
    ).toBeVisible();
    // Full role names name every column; phones show whole short words.
    expect(
      within(matrix)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Ability', 'Owner', 'Admin', 'Builder', 'Operator', 'Viewer']);
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
    // StrictMode may repeat the first page while the route's warm-up read is
    // in flight; the next page is asked for once, after it.
    expect(requestedCursors.at(-1)).toBe('next-page');
    expect(new Set(requestedCursors)).toEqual(new Set([null, 'next-page']));
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
});
