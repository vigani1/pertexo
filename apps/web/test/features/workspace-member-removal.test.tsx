import { HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  api,
  firstMemberId,
  identityHandlers,
  member,
  memberCommandHandler,
  membersOf,
  noInvitations,
  ownerWorkspace,
  problem,
  rowOf,
  secondMemberId,
  userId,
  workspaceId,
  type SentMemberCommand,
} from '../support/team-fixtures';

const thirdMemberId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const workspaceName = ownerWorkspace.name;

type Removal = SentMemberCommand;

function removalHandler(
  removals: Removal[],
  answer: (attempt: number) => Response,
) {
  return memberCommandHandler('remove', removals, answer);
}

function removalDialog() {
  return screen.queryByRole('dialog', { name: /^Remove /u });
}

async function openRemoval(
  actor: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await actor.click(
    await screen.findByRole('button', { name: `Actions for ${name}` }),
  );
  await actor.click(
    await screen.findByRole('menuitem', { name: 'Remove from workspace' }),
  );
  return within(await screen.findByRole('dialog', { name: /^Remove / }));
}

describe('team: member removal', () => {
  it('confirms what removal does, sends it once and refreshes the team', async () => {
    const removals: Removal[] = [];
    let members = [
      member(userId, 'Pertexo Operator', 'owner'),
      member(firstMemberId, 'Ada Lovelace', 'builder', 3),
    ];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => members),
      noInvitations(),
      removalHandler(removals, () => {
        members = members.filter((item) => item.userId !== firstMemberId);
        return HttpResponse.json({
          userId: firstMemberId,
          roleRevision: 4,
          replayed: false,
        });
      }),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`, { strict: true });

    const dialog = await openRemoval(actor, 'Ada Lovelace');
    expect(
      dialog.getByRole('heading', {
        name: `Remove Ada Lovelace from ${workspaceName}?`,
      }),
    ).toBeVisible();
    expect(dialog.getByText(/signed out everywhere/u)).toBeVisible();
    expect(
      dialog.getByText(/invitations they sent stay pending/u),
    ).toBeVisible();
    await actor.click(dialog.getByRole('button', { name: 'Remove member' }));

    expect(
      await screen.findByText(`Ada Lovelace was removed from ${workspaceName}`),
    ).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    });
    expect(removalDialog()).not.toBeInTheDocument();
    expect(removals).toEqual([
      {
        key: expect.any(String) as unknown,
        body: { expectedRoleRevision: 3 },
        url: `/v1/workspaces/${workspaceId}/members/${firstMemberId}/remove`,
      },
    ]);
  });

  it('offers removal only for members the actor may remove', async () => {
    mockServer.use(
      ...identityHandlers({ ...ownerWorkspace, role: 'admin' }),
      membersOf(() => [
        member(userId, 'Pertexo Operator', 'admin'),
        member(firstMemberId, 'Owner Person', 'owner'),
        member(secondMemberId, 'Peer Admin', 'admin'),
        member(thirdMemberId, 'Viewer Person', 'viewer'),
      ]),
      noInvitations(),
    );
    renderApp(`/w/${workspaceId}/team`);

    expect(
      await screen.findByRole('button', { name: 'Actions for Viewer Person' }),
    ).toBeVisible();
    for (const name of ['Pertexo Operator', 'Owner Person', 'Peer Admin'])
      expect(
        rowOf(name).queryByRole('button', { name: `Actions for ${name}` }),
      ).not.toBeInTheDocument();
  });

  it('keeps an unconfirmed removal on its member and repeats it exactly', async () => {
    const removals: Removal[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Lovelace', 'viewer')]),
      noInvitations(),
      removalHandler(removals, (attempt) =>
        attempt === 1
          ? HttpResponse.error()
          : HttpResponse.json({
              userId: firstMemberId,
              roleRevision: 2,
              replayed: true,
            }),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`);

    const dialog = await openRemoval(actor, 'Ada Lovelace');
    await actor.click(dialog.getByRole('button', { name: 'Remove member' }));
    expect(
      await dialog.findByText(
        /couldn’t confirm whether Ada Lovelace was removed/u,
      ),
    ).toBeVisible();
    await actor.keyboard('{Escape}');
    expect(removalDialog()).toBeInTheDocument();
    await actor.click(dialog.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText(`Ada Lovelace was removed from ${workspaceName}`),
    ).toBeVisible();
    expect(removals).toHaveLength(2);
    expect(removals[1]).toEqual(removals[0]);
  });

  it('asks again after a stale revision and says when the member is already gone', async () => {
    let answer = problem(409, 'workspace.member_role_revision_conflict');
    const removals: Removal[] = [];
    mockServer.use(
      ...identityHandlers(ownerWorkspace),
      membersOf(() => [member(firstMemberId, 'Ada Lovelace', 'viewer')]),
      noInvitations(),
      removalHandler(removals, () => answer),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${workspaceId}/team`);

    let dialog = await openRemoval(actor, 'Ada Lovelace');
    await actor.click(dialog.getByRole('button', { name: 'Remove member' }));
    expect(
      await rowOf('Ada Lovelace').findByText(
        /role changed while you were deciding/u,
      ),
    ).toBeVisible();
    expect(removalDialog()).not.toBeInTheDocument();

    answer = problem(409, 'workspace.member_removal_conflict');
    dialog = await openRemoval(actor, 'Ada Lovelace');
    await actor.click(dialog.getByRole('button', { name: 'Remove member' }));
    expect(
      await screen.findByText('Ada Lovelace is no longer in this workspace'),
    ).toBeVisible();
    expect(new Set(removals.map((removal) => removal.key)).size).toBe(2);
  });
});
