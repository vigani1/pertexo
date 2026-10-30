import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it, vi } from 'vitest';

import {
  api,
  firstMemberId,
  identityHandlers,
  member,
  membersOf,
  noInvitations,
  ownerWorkspace,
  problem,
  user,
  workspaceId,
} from '../../support/fixtures/team';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import { invitation, lens, sheet } from './members/fixture';

describe('team: invitations', () => {
  it('explains unavailable issuance, blocks a direct Invite link, and leaves revocation usable', async () => {
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'owner')]),
      http.get(`${api}/invitations`, () =>
        HttpResponse.json({
          issuanceAvailable: false,
          items: [invitation('existing@example.test')],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/team?tab=invitations&invite=true`, {
      strict: true,
    });
    expect(
      await screen.findByText(/Invitations are unavailable on this server/u),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Invite people' }),
    ).toBeDisabled();
    expect(sheet()).not.toBeInTheDocument();
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', {
        name: 'Actions for existing@example.test',
      }),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Send a new link' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      await screen.findByRole('menuitem', { name: 'Revoke invitation' }),
    ).toBeEnabled();
  });
  it('explains a server that loses invitation configuration after the form opens', async () => {
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Operator', 'owner')]),
      noInvitations(),
      http.post(`${api}/invitations`, () =>
        problem(503, 'workspace.invitation_not_configured'),
      ),
    );
    renderApp(`/w/${workspaceId}/team`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Invite people' }),
    );
    await actor.type(
      lens().getByLabelText('Email addresses'),
      'new@example.test',
    );
    await actor.click(lens().getByRole('button', { name: 'Send invitation' }));
    expect(
      await screen.findByText(
        'Invitations are unavailable on this server. Ask the operator to configure invitations.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/still being delivered|role changed/u),
    ).not.toBeInTheDocument();
  });
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
  // web-app-04: the invitation command resends its held key after any delay.
  it.fails(
    'refuses to resend an uncertain invitation once its 24-hour receipt window has passed',
    async () => {
      const commandRequests: (string | null)[] = [];
      mockServer.use(
        ...identityHandlers(ownerWorkspace),
        membersOf(() => [member(firstMemberId, 'Ada Operator', 'viewer')]),
        noInvitations(),
        http.post(`${api}/invitations`, ({ request }) => {
          commandRequests.push(request.headers.get('idempotency-key'));
          return HttpResponse.error();
        }),
      );
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const browser = userEvent.setup();
        renderApp(`/w/${workspaceId}/team`);
        await browser.click(
          await screen.findByRole('button', { name: 'Invite people' }),
        );
        await browser.type(
          lens().getByLabelText('Email addresses'),
          'late@example.test',
        );
        await browser.click(
          lens().getByRole('button', { name: 'Send invitation' }),
        );
        await lens().findByRole('alert');
        // The server forgets an idempotency key after 24 hours.
        vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 60_000);
        const retry = lens().queryByRole('button', { name: 'Try again' });
        if (retry !== null) await browser.click(retry);
        expect(await screen.findByText(/24-hour/u)).toBeVisible();
        expect(commandRequests).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
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
          issuanceAvailable: true,
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
});
