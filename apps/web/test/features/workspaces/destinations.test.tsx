import type { AccessibleWorkspace } from '@pertexo/contracts';
import { capabilitiesForRole } from '@pertexo/workflow-model';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  authenticatedHandlers,
  workspace,
  workspaceId,
} from '../auth/workspace-entry/fixture';

function serveAs(role: AccessibleWorkspace['role']) {
  mockServer.use(...authenticatedHandlers());
  mockServer.use(
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          { ...workspace, role, capabilities: capabilitiesForRole(role) },
        ],
        nextCursor: null,
      }),
    ),
  );
}

const names = (links: readonly HTMLElement[]) =>
  links.map((link) => link.getAttribute('aria-label') ?? link.textContent);

// Each place is offered where the role may open it, the same in the spine
// and in the command palette: runs need run:read, connections
// connection:read, the team member:read and alerts workflow:update.
describe('workspace destinations by role', () => {
  it.each([
    {
      role: 'viewer',
      spine: [
        'Workflows',
        'Runs',
        'Inbox',
        'Data tables',
        'Connections',
        'Settings',
      ],
      palette: { Runs: true, Connections: true, Team: false, Alerts: false },
    },
    {
      role: 'builder',
      spine: [
        'Workflows',
        'Runs',
        'Inbox',
        'Data tables',
        'Connections',
        'Settings',
      ],
      palette: { Runs: true, Connections: true, Team: false, Alerts: true },
    },
    {
      role: 'admin',
      spine: [
        'Workflows',
        'Runs',
        'Inbox',
        'Data tables',
        'Connections',
        'Team',
        'Settings',
      ],
      palette: { Runs: true, Connections: true, Team: true, Alerts: true },
    },
  ] as const)(
    'offers a $role the spine and palette places their role can open',
    async ({ role, spine, palette }) => {
      serveAs(role);
      renderApp(`/w/${workspaceId}/workflows`);
      await screen.findByRole('heading', { name: 'Workflows' });
      const nav = screen
        .getAllByRole('navigation', { name: 'Workspace' })
        .find((candidate) =>
          within(candidate).queryByRole('button', { name: 'Search' }),
        );
      if (nav === undefined) throw new Error('No workspace spine');
      const offered = names(within(nav).getAllByRole('link')).filter(
        (name) => name !== 'Home',
      );
      expect(offered.map((name) => name.replace(/\d+.*$/u, '').trim())).toEqual(
        [...spine],
      );
      await userEvent
        .setup()
        .click(within(nav).getByRole('button', { name: 'Search' }));
      const dialog = await screen.findByRole('dialog');
      for (const [place, shown] of Object.entries(palette))
        expect(
          within(dialog).queryByRole('option', { name: place }) !== null,
        ).toBe(shown);
    },
  );

  it.each([
    {
      role: 'viewer',
      rail: ['General', 'Usage', 'Variables', 'Notifications', 'API tokens'],
    },
    {
      role: 'builder',
      rail: [
        'General',
        'Usage',
        'Variables',
        'Alerts',
        'Promotion',
        'Notifications',
        'API tokens',
      ],
    },
    {
      role: 'admin',
      rail: [
        'General',
        'Usage',
        'Variables',
        'Alerts',
        'Promotion',
        'Audit log',
        'Single sign-on',
        'Notifications',
        'API tokens',
      ],
    },
  ] as const)(
    'offers a $role the settings pages their role can open',
    async ({ role, rail }) => {
      serveAs(role);
      renderApp(`/w/${workspaceId}/settings`);
      const settings = await screen.findByRole('navigation', {
        name: 'Settings',
      });
      expect(names(within(settings).getAllByRole('link'))).toEqual([...rail]);
    },
  );
});
