import type { AccessibleWorkspace } from '@pertexo/contracts';
import { capabilitiesForRole } from '@pertexo/policy';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
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
      await renderLoadedApp(`/w/${workspaceId}/workflows`);
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
      const actor = userEvent.setup();
      await actor.click(within(nav).getByRole('button', { name: 'Search' }));
      const dialog = within(await screen.findByRole('dialog'));
      const search = dialog.getByRole('combobox', {
        name: 'Search pages, workflows and actions',
      });
      for (const [place, shown] of Object.entries(palette)) {
        await actor.clear(search);
        await actor.paste(place);
        expect(dialog.queryByRole('option', { name: place }) !== null).toBe(
          shown,
        );
      }
    },
  );

  it.each([
    {
      role: 'viewer',
      rail: [
        'General',
        'Usage',
        'Variables',
        'Notifications',
        'API tokens',
        'Account',
      ],
      advanced: [],
    },
    {
      role: 'builder',
      rail: [
        'General',
        'Usage',
        'Variables',
        'Alerts',
        'Notifications',
        'API tokens',
        'Account',
        'Promotion',
      ],
      advanced: ['Promotion'],
    },
    {
      role: 'admin',
      rail: [
        'General',
        'Usage',
        'Variables',
        'Alerts',
        'Notifications',
        'API tokens',
        'Account',
        'Promotion',
        'Audit log',
        'Single sign-on',
      ],
      advanced: ['Promotion', 'Audit log', 'Single sign-on'],
    },
  ] as const)(
    'offers a $role the settings pages their role can open',
    async ({ role, rail, advanced }) => {
      serveAs(role);
      await renderLoadedApp(`/w/${workspaceId}/settings`);
      const settings = await screen.findByRole('navigation', {
        name: 'Settings',
      });
      expect(names(within(settings).getAllByRole('link'))).toEqual([...rail]);
      // product-ux-17: what most workspaces never need comes last, labelled.
      const group = within(settings).queryByLabelText('Advanced');
      if (advanced.length === 0) expect(group).toBeNull();
      else
        expect(names(within(group ?? settings).getAllByRole('link'))).toEqual([
          ...advanced,
        ]);
    },
  );

  it('suggests a few workspace actions and keeps the full palette searchable', async () => {
    serveAs('admin');
    const dialog = within(await openPalette());
    expect(
      dialog.getAllByRole('option').map((option) => option.textContent.trim()),
    ).toEqual(['Invite people', 'Team', 'Workflows', 'Runs']);
    expect(dialog.getByText('Paste a run ID to open that run.')).toBeVisible();
    const actor = userEvent.setup();
    const search = dialog.getByRole('combobox', {
      name: 'Search pages, workflows and actions',
    });
    for (const name of [
      'New workflow',
      'Add a connection',
      'Home',
      'Inbox',
      'Approvals',
      'Data tables',
      'Connections',
      'Alerts',
      'Variables',
      'Usage',
      'Workspace settings',
      'Audit log',
      'API tokens',
      'Guide: your first workflow',
      'Glossary',
      'Switch theme',
    ]) {
      await actor.clear(search);
      await actor.paste(name);
      const option = dialog.getByRole('option', { name });
      expect(option).toBeVisible();
      expect(option.querySelector('svg')).not.toBeNull();
    }
  });

  it('offers a viewer no actions they can’t take even when searched', async () => {
    serveAs('viewer');
    const dialog = within(await openPalette());
    const actor = userEvent.setup();
    const search = dialog.getByRole('combobox', {
      name: 'Search pages, workflows and actions',
    });
    for (const name of ['New workflow', 'Invite people']) {
      await actor.clear(search);
      await actor.paste(name);
      expect(dialog.queryByRole('option', { name })).toBeNull();
    }
    await actor.clear(search);
    await actor.paste('Home');
    expect(dialog.getByRole('option', { name: 'Home' })).toBeVisible();
  });
});

/** The workflow list, with the palette opened from the spine's Search. */
async function openPalette() {
  await renderLoadedApp(`/w/${workspaceId}/workflows`);
  await screen.findByRole('heading', { name: 'Workflows' });
  const nav = screen
    .getAllByRole('navigation', { name: 'Workspace' })
    .find((candidate) =>
      within(candidate).queryByRole('button', { name: 'Search' }),
    );
  if (nav === undefined) throw new Error('No workspace spine');
  await userEvent
    .setup()
    .click(within(nav).getByRole('button', { name: 'Search' }));
  return screen.findByRole('dialog');
}
