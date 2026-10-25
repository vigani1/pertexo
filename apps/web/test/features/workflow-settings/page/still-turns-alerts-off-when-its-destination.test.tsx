import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  api,
  destination,
  installQueries,
  problem,
  workflowApi,
} from '../fixtures';

import { region, settingsPath } from './fixture';

describe('workflow settings tab', () => {
  it('still turns alerts off when its destination was the last one enabled', async () => {
    const disabled = { ...destination, status: 'disabled' };
    let current: typeof disabled | null = disabled;
    installQueries();
    mockServer.use(
      http.get(`${api}/failure-notification-destinations`, () =>
        HttpResponse.json({ items: [disabled] }),
      ),
      http.get(`${workflowApi}/failure-notification-policy`, () =>
        HttpResponse.json({ destination: current }),
      ),
      http.delete(`${workflowApi}/failure-notification-policy`, () => {
        current = null;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp(settingsPath);
    const event = userEvent.setup();
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    expect(
      await within(alerts).findByText(
        /There’s no enabled alert destination in this workspace yet/u,
      ),
    ).toBeVisible();
    expect(
      within(alerts).queryByRole('combobox', {
        name: 'Send failure alerts to',
      }),
    ).not.toBeInTheDocument();
    await event.click(
      within(alerts).getByRole('button', { name: 'Turn alerts off' }),
    );
    expect(await screen.findByText('Failure alerts turned off')).toBeVisible();
    expect(
      await within(alerts).findByText(/aren’t announced anywhere/u),
    ).toBeVisible();
  });
  it('blocks a conflicting alert change until the exact uncertain attempt resolves', async () => {
    installQueries();
    const setKeys: string[] = [];
    const clearKeys: string[] = [];
    mockServer.use(
      http.get(`${workflowApi}/failure-notification-policy`, () =>
        HttpResponse.json({ destination }),
      ),
      http.put(`${workflowApi}/failure-notification-policy`, ({ request }) => {
        setKeys.push(request.headers.get('idempotency-key') ?? '');
        return setKeys.length === 1
          ? HttpResponse.error()
          : new HttpResponse(null, { status: 204 });
      }),
      http.delete(
        `${workflowApi}/failure-notification-policy`,
        ({ request }) => {
          clearKeys.push(request.headers.get('idempotency-key') ?? '');
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    renderApp(settingsPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('combobox', { name: 'Send failure alerts to' }),
    );
    await event.click(
      await screen.findByRole('option', {
        name: 'Email to alerts@example.test',
      }),
    );
    await event.click(screen.getByRole('button', { name: 'Save destination' }));
    expect(
      await screen.findByText(
        /couldn’t confirm whether changing where alerts go/u,
      ),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Turn alerts off' }));
    expect(
      await screen.findByText(/An earlier change is still unconfirmed/u),
    ).toBeVisible();
    expect(clearKeys).toHaveLength(0);
    await event.click(screen.getByRole('button', { name: 'Save destination' }));
    expect(await screen.findByText('Failure alerts updated')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Turn alerts off' }));
    await waitFor(() => {
      expect(clearKeys).toHaveLength(1);
    });
    expect(setKeys).toHaveLength(2);
    expect(setKeys[1]).toBe(setKeys[0]);
    expect(clearKeys[0]).not.toBe(setKeys[0]);
  });
  it('explains what a role can’t do instead of offering it', async () => {
    installQueries([]);
    mockServer.use(
      http.get(`${api}/failure-notification-destinations`, () =>
        problem(403, 'auth.forbidden'),
      ),
    );
    renderApp(settingsPath);
    const lifecycle = await screen.findByRole('region', { name: 'Lifecycle' });
    const archive = await within(lifecycle).findByRole('button', {
      name: 'Archive workflow',
    });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAccessibleDescription(
      /can’t archive or restore workflows\. Builders and admins can\./u,
    );
    expect(
      within(region('Failure alerts')).getByText(
        /can’t change failure alerts\. Builders and admins can\./u,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});
