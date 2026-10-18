import { http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
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
  userId,
  workspaceId,
} from '../../support/fixtures/team';

const source = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  directoryUserId: '22222222-2222-4222-8222-222222222222',
  directoryRevision: 2,
  controlWorkspaceId: workspaceId,
};
describe('directory-managed team access', () => {
  it('explains the source and keeps manual role/removal/ownership controls off managed rows', async () => {
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      membersOf(() => [
        member(userId, 'Workspace Owner', 'owner'),
        {
          ...member(firstMemberId, 'Directory Builder', 'builder'),
          directorySource: source,
        },
      ]),
    );
    renderApp(`/w/${workspaceId}/team`);
    await screen.findByText('Directory Builder');
    const row = rowOf('Directory Builder');
    expect(row.getByText(/Directory-managed/u)).toBeVisible();
    expect(
      row.queryByRole('combobox', { name: 'Role for Directory Builder' }),
    ).not.toBeInTheDocument();
    expect(
      row.queryByRole('button', { name: 'Actions for Directory Builder' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeVisible();
  });
  it('handles adoption during an open role review without claiming the owner lost permission', async () => {
    let managed = false;
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      noInvitations(),
      membersOf(() => [
        member(userId, 'Workspace Owner', 'owner'),
        {
          ...member(firstMemberId, 'Directory Builder', 'builder'),
          ...(managed ? { directorySource: source } : {}),
        },
      ]),
      http.post(`${api}/members/${firstMemberId}/role`, () => {
        managed = true;
        return problem(409, 'workspace.member_directory_managed');
      }),
    );
    const { router } = renderApp(`/w/${workspaceId}/team`),
      user = userEvent.setup();
    await user.click(
      await screen.findByRole('combobox', {
        name: 'Role for Directory Builder',
      }),
    );
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Change role',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText(
        /The organization directory controls this membership/u,
      ),
    ).toBeVisible();
    expect(
      rowOf('Directory Builder').getByText(/Directory-managed/u),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/team`);
    expect(screen.queryByText(/Your role changed/u)).not.toBeInTheDocument();
  });
});
