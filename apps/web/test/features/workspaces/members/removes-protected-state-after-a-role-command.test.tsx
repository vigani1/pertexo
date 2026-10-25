import { act, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

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
  userId,
  workspace,
  workspaceId,
} from '../../../support/fixtures/team';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { confirmation, pickRole } from './fixture';

describe('team: members', () => {
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
    let changed = false;
    let refreshes = 0;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      http.get(`${api}/members`, () => {
        if (!changed)
          return HttpResponse.json({
            items: [member(firstMemberId, 'Alice Member', 'viewer')],
            nextCursor: null,
          });
        refreshes += 1;
        return refreshedMembers.promise;
      }),
      http.post(`${api}/members/${firstMemberId}/role`, () => {
        changed = true;
        return HttpResponse.json({
          userId: firstMemberId,
          role: 'operator',
          roleRevision: 2,
          changed: true,
          replayed: false,
        });
      }),
    );
    const { router } = renderApp(`/w/${workspaceId}/team`, { strict: true });
    const browser = userEvent.setup();
    await pickRole(browser, 'Alice Member', 'Operator');
    await browser.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => {
      expect(refreshes).toBe(1);
    });

    await router.navigate({ to: '/workspaces' });
    expect(
      await screen.findByRole('heading', { name: 'Workspaces' }),
    ).toBeVisible();
    await act(async () => {
      refreshedMembers.resolve(
        Response.json({
          items: [member(firstMemberId, 'Alice Member', 'operator', 2)],
          nextCursor: null,
        }),
      );
      await refreshedMembers.promise;
    });
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
});
