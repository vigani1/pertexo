import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  identityHandlers,
  lifecycleChange,
  scheduledForDeletion,
  timestamp,
  user,
  userId,
  workspace,
  workspaceId,
} from './fixture';

describe('workspace settings', () => {
  it('retries an uncertain deletion with the exact reason and key in StrictMode', async () => {
    const commands: { key: string | null; body: unknown }[] = [];
    let attempts = 0;
    mockServer.use(
      ...identityHandlers(),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        async ({ request }) => {
          commands.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          attempts += 1;
          return attempts === 1
            ? HttpResponse.error()
            : HttpResponse.json(lifecycleChange());
        },
      ),
    );

    renderApp(`/w/${workspaceId}/settings`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Delete workspace' }),
    );
    const dialog = within(
      screen.getByRole('dialog', { name: 'Delete Control Operations?' }),
    );
    expect(dialog.getByText(/restore it for 30 days/u)).toBeVisible();
    const confirmation = dialog.getByLabelText(
      'Type “Control Operations” to confirm',
    );
    const reason = dialog.getByLabelText('Reason (required)');
    await actor.click(reason);
    await actor.tab();
    expect(
      dialog.queryByText(/Say why in a sentence/u),
    ).not.toBeInTheDocument();
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));
    expect(dialog.getByText(/Say why in a sentence/u)).toBeVisible();
    expect(confirmation).toHaveFocus();
    expect(confirmation).toHaveAccessibleDescription(
      'Type Control Operations exactly to confirm.',
    );
    await actor.type(confirmation, 'Control Operations');
    expect(confirmation).toHaveAttribute('aria-invalid', 'false');
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));
    expect(reason).toHaveFocus();
    await actor.type(reason, '   ');
    expect(dialog.getByText(/Say why in a sentence/u)).toBeVisible();
    await actor.clear(reason);
    await actor.type(reason, 'No longer needed');
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether the deletion request went through',
    );
    expect(reason).toBeDisabled();
    await actor.click(dialog.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(scheduledForDeletion)).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    expect(commands[0]?.body).toEqual({ reason: 'No longer needed' });
  });
  it('refreshes the workspace once a deletion completes and offers restore after dismissal', async () => {
    let deleted = false;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [
            { ...workspace, status: deleted ? 'pending_deletion' : 'active' },
          ],
          nextCursor: null,
        }),
      ),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        () => {
          deleted = true;
          return HttpResponse.json(lifecycleChange());
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Delete workspace' }),
    );
    const dialog = within(
      screen.getByRole('dialog', { name: 'Delete Control Operations?' }),
    );
    await actor.type(
      dialog.getByLabelText('Type “Control Operations” to confirm'),
      'Control Operations',
    );
    await actor.type(
      dialog.getByLabelText('Reason (required)'),
      'No longer needed',
    );
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));

    expect(await screen.findByText(scheduledForDeletion)).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Restore' })).toBeVisible();
    });
    await actor.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      await screen.findByRole('button', { name: 'Restore workspace' }),
    ).toBeVisible();
  });
  it('restores a pending-deletion workspace', async () => {
    let deletes = 0;
    mockServer.use(
      ...identityHandlers({ ...workspace, status: 'pending_deletion' }),
      http.delete(
        `http://pertexo.test/v1/workspaces/${workspaceId}/deletion`,
        ({ request }) => {
          deletes += 1;
          expect(request.headers.get('idempotency-key')).toBeTruthy();
          return HttpResponse.json(lifecycleChange('deletion_restored'));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Restore workspace' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Restore Control Operations?',
    });
    expect(dialog).toHaveTextContent(/integrations stay off/u);
    await actor.click(
      within(dialog).getByRole('button', { name: 'Restore workspace' }),
    );
    expect(
      await screen.findByText(
        'The workspace is back, suspended. Triggers and integrations stay off until you reconnect them.',
      ),
    ).toBeVisible();
    expect(deletes).toBe(1);
  });
  it('counts what lives in the workspace, each tile opening its page', async () => {
    const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
    const workflow = (id: string, overrides: Record<string, unknown>) => ({
      id,
      workspaceId,
      name: `Workflow ${id.slice(0, 2)}`,
      nameRevision: 1,
      lifecycleStatus: 'active',
      lifecycleRevision: 1,
      activationStatus: 'active',
      webhookSetupRequired: false,
      publishedVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...overrides,
    });
    const person = (id: string, role: string) => ({
      userId: id,
      email: `${id.slice(0, 8)}@example.test`,
      displayName: `Person ${id.slice(0, 2)}`,
      role,
      roleRevision: 1,
      membershipStatus: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: [
          'workspace:read',
          'workspace:manage',
          'member:read',
          'workflow:read',
          'workflow:update',
          'connection:read',
        ],
      }),
      http.get(`${api}/workflows`, () =>
        HttpResponse.json({
          items: [
            workflow('11111111-1111-4111-8111-111111111111', {}),
            workflow('22222222-2222-4222-8222-222222222222', {
              publishedVersionId: null,
              activationStatus: 'inactive',
            }),
            workflow('33333333-3333-4333-8333-333333333333', {
              lifecycleStatus: 'archived',
            }),
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/members`, () =>
        HttpResponse.json({
          items: [
            person(userId, 'owner'),
            person('44444444-4444-4444-8444-444444444444', 'builder'),
            person('55555555-5555-4555-8555-555555555555', 'builder'),
          ],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/connections`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${api}/failure-notification-destinations`, () =>
        HttpResponse.json({ items: [] }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const glance = within(
      await screen.findByRole('region', { name: 'At a glance' }),
    );
    const tile = (name: RegExp) => glance.getByRole('link', { name });
    await waitFor(() => {
      expect(tile(/workflows/u)).toHaveTextContent('2workflows');
    });
    expect(tile(/workflows/u)).toHaveTextContent('1 live1 draft');
    expect(tile(/workflows/u)).toHaveTextContent('1 archived');
    expect(tile(/workflows/u)).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows`,
    );
    await waitFor(() => {
      expect(tile(/members/u)).toHaveTextContent('1 Owner · 2 Builders');
    });
    expect(tile(/members/u)).toHaveAttribute('href', `/w/${workspaceId}/team`);
    await waitFor(() => {
      expect(tile(/connections/u)).toHaveTextContent('Nothing connected yet');
    });
    expect(tile(/alert destinations/u)).toHaveAttribute(
      'href',
      `/w/${workspaceId}/settings/alerts`,
    );
  });
  it('marks counts from a first page as floors while more pages exist', async () => {
    const api = `http://pertexo.test/v1/workspaces/${workspaceId}`;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: [
          'workspace:read',
          'member:read',
          'workflow:read',
          'connection:read',
        ],
      }),
      http.get(`${api}/workflows`, () =>
        HttpResponse.json({
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              workspaceId,
              name: 'Workflow 11',
              nameRevision: 1,
              lifecycleStatus: 'active',
              lifecycleRevision: 1,
              activationStatus: 'active',
              webhookSetupRequired: false,
              publishedVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: 'next-workflows',
        }),
      ),
      http.get(`${api}/members`, () =>
        HttpResponse.json({
          items: [
            {
              userId,
              email: 'owner@example.test',
              displayName: 'Owner',
              role: 'owner',
              roleRevision: 1,
              membershipStatus: 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          nextCursor: 'next-members',
        }),
      ),
      http.get(`${api}/connections`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const glance = within(
      await screen.findByRole('region', { name: 'At a glance' }),
    );
    const tile = (name: RegExp) => glance.getByRole('link', { name });
    // Only the first page was read, so "1 live" would claim an exact count.
    await waitFor(() => {
      expect(tile(/workflows/u)).toHaveTextContent('1+workflows1+ live');
    });
    await waitFor(() => {
      expect(tile(/members/u)).toHaveTextContent('1+members1+ Owners');
    });
  });
});
