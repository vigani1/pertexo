import { HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import * as team from '../support/team-fixtures';

const workspaceName = team.ownerWorkspace.name;

type Command = team.SentMemberCommand;

async function openAction(
  actor: ReturnType<typeof userEvent.setup>,
  name: string,
  action: string,
) {
  await actor.click(
    await screen.findByRole('button', { name: `Actions for ${name}` }),
  );
  await actor.click(await screen.findByRole('menuitem', { name: action }));
  return within(await screen.findByRole('dialog'));
}

function suspended(
  memberId: string,
  displayName: string,
  role: 'admin' | 'builder' | 'viewer',
  revision: number,
) {
  return {
    ...team.member(memberId, displayName, role, revision),
    membershipStatus: 'suspended',
  };
}

describe('team: suspension and reactivation', () => {
  it('suspends after saying what happens, then shows the member as suspended', async () => {
    const sent: Command[] = [];
    const owner = team.member(team.userId, 'Pertexo Operator', 'owner');
    let members = [
      owner,
      team.member(team.firstMemberId, 'Ada Lovelace', 'builder', 3),
    ];
    mockServer.use(
      ...team.identityHandlers(team.ownerWorkspace),
      team.membersOf(() => members),
      team.noInvitations(),
      team.memberCommandHandler('suspend', sent, () => {
        members = [
          owner,
          suspended(team.firstMemberId, 'Ada Lovelace', 'builder', 4),
        ];
        return HttpResponse.json({
          userId: team.firstMemberId,
          roleRevision: 4,
          membershipStatus: 'suspended',
          replayed: false,
        });
      }),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${team.workspaceId}/team`, { strict: true });

    await actor.click(
      await screen.findByRole('button', { name: 'Actions for Ada Lovelace' }),
    );
    expect(
      (await screen.findAllByRole('menuitem')).map((item) => item.textContent),
    ).toEqual(['Make owner…', 'Suspend…', 'Remove from workspace']);
    await actor.click(screen.getByRole('menuitem', { name: 'Suspend…' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(
      dialog.getByRole('heading', { name: 'Suspend Ada Lovelace?' }),
    ).toBeVisible();
    expect(dialog.getByText(/until someone reactivates them/u)).toBeVisible();
    expect(dialog.getByText(/signed out everywhere/u)).toBeVisible();
    expect(dialog.getByText(/keep the Builder role/u)).toBeVisible();
    await actor.click(dialog.getByRole('button', { name: 'Suspend member' }));

    expect(await screen.findByText('Ada Lovelace was suspended')).toBeVisible();
    await waitFor(() => {
      expect(
        team.rowOf('Ada Lovelace').getAllByText(/suspended/iu),
      ).not.toHaveLength(0);
    });
    expect(sent).toEqual([
      {
        key: expect.any(String) as unknown,
        body: { expectedRoleRevision: 3 },
        url: `/v1/workspaces/${team.workspaceId}/members/${team.firstMemberId}/suspend`,
      },
    ]);
  });

  it('reactivates a suspended member with their role, and repeats an unconfirmed attempt exactly', async () => {
    const sent: Command[] = [];
    mockServer.use(
      ...team.identityHandlers(team.ownerWorkspace),
      team.membersOf(() => [
        team.member(team.userId, 'Pertexo Operator', 'owner'),
        suspended(team.firstMemberId, 'Ada Lovelace', 'viewer', 2),
      ]),
      team.noInvitations(),
      team.memberCommandHandler('reactivate', sent, (attempt) =>
        attempt === 1
          ? HttpResponse.error()
          : HttpResponse.json({
              userId: team.firstMemberId,
              roleRevision: 3,
              membershipStatus: 'active',
              replayed: true,
            }),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${team.workspaceId}/team`);

    const dialog = await openAction(actor, 'Ada Lovelace', 'Reactivate…');
    expect(dialog.getByText(/back as a Viewer/u)).toBeVisible();
    await actor.click(
      dialog.getByRole('button', { name: 'Reactivate member' }),
    );
    expect(
      await dialog.findByText(
        /couldn’t confirm whether Ada Lovelace’s access/u,
      ),
    ).toBeVisible();
    await actor.click(dialog.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText('Ada Lovelace was reactivated'),
    ).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]?.body).toEqual({ expectedRoleRevision: 2 });
  });

  it('offers admins suspension only for operational roles and never ownership', async () => {
    mockServer.use(
      ...team.identityHandlers({ ...team.ownerWorkspace, role: 'admin' }),
      team.membersOf(() => [
        team.member(team.userId, 'Pertexo Operator', 'admin'),
        team.member(team.firstMemberId, 'Peer Admin', 'admin'),
        team.member(team.secondMemberId, 'Viewer Person', 'viewer'),
      ]),
      team.noInvitations(),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${team.workspaceId}/team`);

    await actor.click(
      await screen.findByRole('button', { name: 'Actions for Viewer Person' }),
    );
    expect(
      (await screen.findAllByRole('menuitem')).map((item) => item.textContent),
    ).toEqual(['Suspend…', 'Remove from workspace']);
    expect(
      team.rowOf('Peer Admin').queryByRole('button', {
        name: 'Actions for Peer Admin',
      }),
    ).not.toBeInTheDocument();
  });

  it('refreshes and explains a member who is no longer in the state it showed', async () => {
    const sent: Command[] = [];
    mockServer.use(
      ...team.identityHandlers(team.ownerWorkspace),
      team.membersOf(() => [
        team.member(team.userId, 'Pertexo Operator', 'owner'),
        team.member(team.firstMemberId, 'Ada Lovelace', 'viewer'),
      ]),
      team.noInvitations(),
      team.memberCommandHandler('suspend', sent, () =>
        team.problem(409, 'workspace.member_status_conflict'),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${team.workspaceId}/team`);

    const dialog = await openAction(actor, 'Ada Lovelace', 'Suspend…');
    await actor.click(dialog.getByRole('button', { name: 'Suspend member' }));
    expect(
      await team
        .rowOf('Ada Lovelace')
        .findByText(/changed while you were deciding/u),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('team: ownership transfer', () => {
  function transferHandlers(
    sent: Command[],
    answer: (attempt: number) => Response,
  ) {
    return [
      ...team.identityHandlers(team.ownerWorkspace),
      team.membersOf(() => [
        team.member(team.userId, 'Pertexo Operator', 'owner', 5),
        team.member(team.firstMemberId, 'Ada Lovelace', 'builder', 2),
      ]),
      team.noInvitations(),
      team.memberCommandHandler('transfer-ownership', sent, answer),
    ];
  }

  it('spells out every consequence and asks for a fresh sign-in when the server wants one', async () => {
    const sent: Command[] = [];
    mockServer.use(
      ...transferHandlers(sent, () =>
        team.problem(403, 'auth.session_not_fresh'),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${team.workspaceId}/team`);

    const dialog = await openAction(actor, 'Ada Lovelace', 'Make owner…');
    expect(
      dialog.getByRole('heading', {
        name: `Make Ada Lovelace the owner of ${workspaceName}?`,
      }),
    ).toBeVisible();
    for (const consequence of [
      /Ada becomes the owner/u,
      /You become an admin/u,
      /You and Ada are both signed out everywhere/u,
      /owner can’t leave until they hand it over/u,
      /sign-in from the last five minutes/u,
    ])
      expect(dialog.getByText(consequence)).toBeVisible();
    await actor.click(dialog.getByRole('button', { name: 'Make owner' }));

    expect(
      await dialog.findByText(
        /sign in again, then confirm within five minutes/u,
      ),
    ).toBeVisible();
    expect(dialog.getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      `/logout?returnTo=%2Fw%2F${team.workspaceId}%2Fteam`,
    );
    expect(sent).toEqual([
      {
        key: expect.any(String) as unknown,
        body: { expectedRoleRevision: 2, expectedOwnerRoleRevision: 5 },
        url: `/v1/workspaces/${team.workspaceId}/members/${team.firstMemberId}/transfer-ownership`,
      },
    ]);
  });

  it('confirms the new owner and says the previous owner must sign in again', async () => {
    const sent: Command[] = [];
    mockServer.use(
      ...transferHandlers(sent, () =>
        HttpResponse.json({
          ownerUserId: team.firstMemberId,
          ownerRoleRevision: 3,
          previousOwnerUserId: team.userId,
          previousOwnerRoleRevision: 6,
          replayed: false,
        }),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${team.workspaceId}/team`);

    const dialog = await openAction(actor, 'Ada Lovelace', 'Make owner…');
    await actor.click(dialog.getByRole('button', { name: 'Make owner' }));

    expect(
      await screen.findByText(
        `Ada Lovelace is now the owner of ${workspaceName}`,
      ),
    ).toBeVisible();
    expect(
      await screen.findByRole('heading', {
        name: 'Your session is no longer available',
      }),
    ).toBeVisible();
    expect(sent).toHaveLength(1);
  });
});
