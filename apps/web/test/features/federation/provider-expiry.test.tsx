import { useState } from 'react';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderForm } from '@/features/federation/components/providers/provider-form';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { mockServer } from '../../support/mock-server';
import { organization, settings, userId, workspaceId } from './fixtures';

afterEach(() => vi.restoreAllMocks());
function Editor() {
  const [open, setOpen] = useState(true);
  return open ? (
    <ProviderForm
      scope={{
        apiClient: createApiClient({
          fetch: testFetch,
          readCsrfToken: () =>
            'csrf-token-for-component-tests-12345678901234567890',
        }),
        userId,
        workspaceId,
      }}
      organization={organization}
      {...(organization.providers[0] === undefined
        ? {}
        : { provider: organization.providers[0] })}
      onClose={() => {
        setOpen(false);
      }}
    />
  ) : (
    <p>Provider editor closed</p>
  );
}
it('lets an expired uncertain provider save inspect current settings and explicitly discard without replay', async () => {
  let writes = 0;
  mockServer.use(
    http.put('*/v1/workspaces/:workspaceId/sso/providers/:providerId', () => {
      writes++;
      return HttpResponse.error();
    }),
    http.get('*/v1/workspaces/:workspaceId/sso', () =>
      HttpResponse.json(settings),
    ),
  );
  renderInRouter(<Editor />);
  const user = userEvent.setup();
  await user.clear(await screen.findByLabelText('Provider name'));
  await user.type(screen.getByLabelText('Provider name'), 'My retained name');
  await user.click(screen.getByRole('button', { name: 'Save provider' }));
  await screen.findByRole('button', { name: 'Retry same request' });
  const future = Date.now() + 86_400_001;
  vi.spyOn(Date, 'now').mockReturnValue(future);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
  await user.click(
    await screen.findByRole('button', { name: 'Check current settings' }),
  );
  expect(await screen.findByText('Current provider settings')).toBeVisible();
  expect(screen.getByLabelText('Provider name')).toHaveValue(
    'My retained name',
  );
  expect(writes).toBe(1);
  await user.click(screen.getByRole('button', { name: 'Discard and close' }));
  expect(await screen.findByText('Provider editor closed')).toBeVisible();
  expect(writes).toBe(1);
});

it('keeps an expired provider draft and an exit available when inspecting current settings fails', async () => {
  let writes = 0;
  let readFails = true;
  mockServer.use(
    http.put('*/v1/workspaces/:workspaceId/sso/providers/:providerId', () => {
      writes++;
      return HttpResponse.error();
    }),
    http.get('*/v1/workspaces/:workspaceId/sso', () =>
      readFails
        ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json(settings),
    ),
  );
  renderInRouter(<Editor />);
  const user = userEvent.setup();
  const name = await screen.findByLabelText('Provider name');
  await user.clear(name);
  await user.type(name, 'Keep this through failed inspection');
  await user.click(screen.getByRole('button', { name: 'Save provider' }));
  await screen.findByRole('button', { name: 'Retry same request' });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86_400_001);
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
  await user.click(
    await screen.findByRole('button', { name: 'Check current settings' }),
  );
  const retry = await screen.findByRole('button', { name: 'Retry' });
  expect(name).toHaveValue('Keep this through failed inspection');
  expect(
    screen.queryByText('Current provider settings'),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Discard and close' }),
  ).toBeEnabled();
  expect(writes).toBe(1);
  readFails = false;
  await user.click(retry);
  expect(await screen.findByText('Current provider settings')).toBeVisible();
  expect(name).toHaveValue('Keep this through failed inspection');
  await user.click(screen.getByRole('button', { name: 'Discard and close' }));
  expect(await screen.findByText('Provider editor closed')).toBeVisible();
  expect(writes).toBe(1);
});
