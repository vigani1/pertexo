import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderLoadedApp } from '../../../support/render-app';

import {
  identityHandlers,
  lifecycleChange,
  scheduledForDeletion,
  user,
  workspace,
  workspaceId,
} from './fixture';

describe('workspace settings', () => {
  it('keeps deletion confirmation and reason after an unconfirmed result and resends it with its key in StrictMode', async () => {
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

    await renderLoadedApp(`/w/${workspaceId}/settings`, { strict: true });
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
      'We couldn’t confirm that change.',
    );
    expect(reason).toBeEnabled();
    await actor.click(dialog.getByRole('button', { name: 'Delete workspace' }));

    expect(await screen.findByText(scheduledForDeletion)).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[0]?.body).toEqual(commands[1]?.body);
    expect(commands[0]?.key).toBe(commands[1]?.key);
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
    await renderLoadedApp(`/w/${workspaceId}/settings`);
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
    await renderLoadedApp(`/w/${workspaceId}/settings`);
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
});
