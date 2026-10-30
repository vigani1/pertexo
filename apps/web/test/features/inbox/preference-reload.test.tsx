import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { NotificationPreferencesPage } from '@/features/inbox/settings.public';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const path = `http://pertexo.test/v1/workspaces/${workspaceId}/notifications`;
const preferences = {
  revision: 0,
  mode: null,
  hour: 9,
  timeZone: 'UTC',
  defaults: { revision: 0, mode: 'off', hour: 9, timeZone: 'UTC' },
  effective: { mode: 'off', hour: 9, timeZone: 'UTC' },
  canManageDefaults: false,
  emailAvailable: true,
  emailUnavailableReason: null,
};

function problem(status: number, code: string) {
  return HttpResponse.json(
    {
      type: `https://pertexo.dev/problems/${code}`,
      title: 'Refused',
      status,
      code,
      requestId: 'preference-reload',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** Saves into a conflict, then reloads the current choices, which fail. */
async function reloadFailingWith(failure: () => Response) {
  let reads = 0;
  mockServer.use(
    http.get(`${path}/preferences`, () => {
      reads += 1;
      return reads === 1 ? HttpResponse.json(preferences) : failure();
    }),
    http.put(`${path}/preferences`, () =>
      problem(409, 'notifications.changed'),
    ),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <NotificationPreferencesPage
        scope={{
          workspaceId,
          userId,
          apiClient: createApiClient({
            fetch: testFetch,
            readCsrfToken: () =>
              'csrf-token-for-component-tests-12345678901234567890',
          }),
        }}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  const section = within(
    await screen.findByRole('region', { name: 'Your email' }),
  );
  await user.click(
    await section.findByRole('combobox', { name: 'Email frequency' }),
  );
  await user.click(await screen.findByRole('option', { name: 'Daily digest' }));
  await user.click(section.getByRole('button', { name: 'Save choices' }));
  await screen.findByText(/Someone changed these notification choices/u);
  await user.click(
    await section.findByRole('button', { name: 'Discard changes' }),
  );
  return section;
}

describe('reloading notification choices', () => {
  it('keeps the edits and says to try again when the reload can’t finish', async () => {
    const section = await reloadFailingWith(
      () => new HttpResponse(null, { status: 503 }),
    );
    expect(
      await section.findByText(
        'Current choices could not be loaded. Your edits are kept.',
      ),
    ).toBeVisible();
  });

  // A reload that loses access fails the page's own read, which then says
  // why in place of the editor.
  it('says the session ended when the reload answers 401', async () => {
    await reloadFailingWith(() => problem(401, 'auth.unauthenticated'));
    expect(
      await screen.findByText('Your session ended. Sign in again.'),
    ).toBeVisible();
    expect(
      screen.queryByText(
        'Current choices could not be loaded. Your edits are kept.',
      ),
    ).not.toBeInTheDocument();
  });

  it('names the lost access when the reload answers 403', async () => {
    await reloadFailingWith(() => problem(403, 'auth.forbidden'));
    expect(
      await screen.findByText(
        'Your role no longer has access to notification choices here.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        'Current choices could not be loaded. Your edits are kept.',
      ),
    ).not.toBeInTheDocument();
  });
});
