import { screen, waitFor } from '@testing-library/react';

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
  workspace,
  workspaceId,
} from '../../../support/fixtures/team';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { confirmation, pickRole } from './fixture';

describe('team: members', () => {
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
