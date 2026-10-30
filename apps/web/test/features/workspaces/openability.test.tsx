import type { AccessibleWorkspace } from '@pertexo/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceFixture } from '../../support/fixtures/identity';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  authenticatedHandlers,
  userId,
  workspace,
  workspaceId,
} from '../auth/workspace-entry/fixture';

// ADR 013/027: a restored workspace comes back suspended, and people can sign
// in and look around it. Only a workspace being deleted stays closed to
// those who can't restore it.
const suspended = { ...workspace, status: 'suspended' } as const;
const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const thirdId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const active = (id: string, name: string) =>
  createWorkspaceFixture({ id, name, capabilities: ['workspace:read'] });
const beingDeleted = (id: string, name: string) =>
  createWorkspaceFixture({
    id,
    name,
    status: 'pending_deletion',
    role: 'viewer',
    capabilities: ['workspace:read'],
  });

function listWorkspaces(items: readonly AccessibleWorkspace[]) {
  mockServer.use(...authenticatedHandlers());
  mockServer.use(
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items, nextCursor: null }),
    ),
  );
}

function rememberWorkspace(id: string, rememberedBy = userId) {
  localStorage.setItem(
    'pertexo:last-workspace',
    JSON.stringify({
      userId: rememberedBy,
      workspaceId: id,
      workspaceName: '',
    }),
  );
}

async function expectLandedOn(app: ReturnType<typeof renderApp>, path: string) {
  await waitFor(() => {
    expect(app.router.state.location.pathname).toBe(path);
  });
}

const suspendedBanner =
  /This workspace is suspended\. You can look around, but runs and changes are paused\./u;

beforeEach(() => {
  localStorage.clear();
});

describe('which workspaces can be opened', () => {
  // web-app-02: the picker blocks a suspended workspace the banner invites in.
  it('opens a suspended workspace from the picker, with its banner', async () => {
    listWorkspaces([suspended, active(otherId, 'Field Team')]);
    const app = renderApp('/workspaces');
    const entry = await screen.findByRole('button', {
      name: /Control Operations/u,
    });
    expect(entry).toBeEnabled();
    expect(entry).not.toHaveTextContent('Contact support');
    await userEvent.setup().click(entry);
    await waitFor(() => {
      expect(app.router.state.location.pathname).toMatch(
        new RegExp(`^/w/${workspaceId}`, 'u'),
      );
    });
    expect(await screen.findByText(suspendedBanner)).toBeVisible();
  });

  it('shows the suspended banner on a suspended workspace’s pages', async () => {
    listWorkspaces([suspended]);
    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText(suspendedBanner)).toBeVisible();
  });

  // web-app-02 + web-app-08: landing skips a suspended workspace.
  it('lands on the only workspace when it is suspended', async () => {
    listWorkspaces([suspended]);
    const app = renderApp('/');
    await expectLandedOn(app, `/w/${workspaceId}`);
  });

  // web-app-02 + web-app-08: landing skips a remembered suspended workspace.
  it('lands on the remembered workspace when it is suspended', async () => {
    rememberWorkspace(workspaceId);
    listWorkspaces([
      active(otherId, 'Field Team'),
      suspended,
      active(thirdId, 'Back Office'),
    ]);
    const app = renderApp('/');
    await expectLandedOn(app, `/w/${workspaceId}`);
  });

  it('lands on the workspace remembered by the same person', async () => {
    rememberWorkspace(workspaceId);
    listWorkspaces([active(otherId, 'Field Team'), workspace]);
    const app = renderApp('/');
    await expectLandedOn(app, `/w/${workspaceId}`);
  });

  it('ignores a workspace another person opened last in this browser', async () => {
    rememberWorkspace(workspaceId, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    listWorkspaces([active(otherId, 'Field Team'), workspace]);
    const app = renderApp('/');
    await expectLandedOn(app, '/workspaces');
  });

  it('never lands in a workspace being deleted that the person can’t restore', async () => {
    rememberWorkspace(otherId);
    listWorkspaces([
      beingDeleted(otherId, 'Old Ops'),
      workspace,
      active(thirdId, 'Back Office'),
    ]);
    const app = renderApp('/');
    await expectLandedOn(app, '/workspaces');
  });

  it('lands on the only workspace that can be opened', async () => {
    listWorkspaces([beingDeleted(otherId, 'Old Ops'), workspace]);
    const app = renderApp('/');
    await expectLandedOn(app, `/w/${workspaceId}`);
  });

  // web-app-02: a deep link opens what the picker and landing keep closed.
  it('keeps a deep link out of a workspace being deleted that the person can’t restore', async () => {
    listWorkspaces([beingDeleted(workspaceId, 'Control Operations')]);
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('heading', {
        name: 'This workspace isn’t available',
      }),
    ).toBeVisible();
  });

  // web-app-02: the switcher links to every workspace, whatever its status.
  it('offers the switcher only the workspaces that can be opened', async () => {
    listWorkspaces([
      workspace,
      { ...active(otherId, 'Field Team'), status: 'suspended' },
      beingDeleted(thirdId, 'Old Ops'),
    ]);
    renderApp(`/w/${workspaceId}/workflows`);
    await screen.findByRole('heading', { name: 'Workflows' });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /Switch workspace/u }));
    expect(
      await screen.findByRole('menuitem', { name: /Field Team/u }),
    ).toHaveAttribute('href', `/w/${otherId}`);
    expect(document.querySelector(`a[href="/w/${thirdId}"]`)).toBeNull();
  });
});
