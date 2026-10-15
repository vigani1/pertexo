import { notificationPreferencesQueryOptions } from '@/features/inbox/data/preferences.queries';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { createApiClient } from '@/lib/api/client';
import { NotificationPreferencesPage } from '@/features/inbox/settings.public';
import { NoticeSubjectActions } from '@/features/inbox/subscriptions.public';
import { mockServer } from '../../support/mock-server';
import { renderApp, testFetch } from '../../support/render-app';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const path = `http://pertexo.test/v1/workspaces/${workspaceId}/notifications`;
function scope() {
  return {
    workspaceId,
    userId,
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
  };
}
function snapshot() {
  return {
    revision: 0,
    mode: null as 'off' | 'immediate' | 'hourly' | 'daily' | null,
    hour: 9,
    timeZone: 'UTC',
    defaults: { revision: 0, mode: 'off' as const, hour: 9, timeZone: 'UTC' },
    effective: { mode: 'off' as const, hour: 9, timeZone: 'UTC' },
    canManageDefaults: false,
    emailAvailable: true,
    emailUnavailableReason: null as string | null,
  };
}
it('keeps an uncertain email save frozen and retries its exact body and key', async () => {
  const user = userEvent.setup();
  let current = snapshot();
  const requests: { key: string | null; body: unknown }[] = [];
  mockServer.use(
    http.get(`${path}/preferences`, () => HttpResponse.json(current)),
    http.put(`${path}/preferences`, async ({ request }) => {
      const body = (await request.json()) as {
        mode: 'off';
        hour: number;
        timeZone: string;
        expectedRevision: number;
      };
      requests.push({ key: request.headers.get('Idempotency-Key'), body });
      if (requests.length === 1) return new HttpResponse(null, { status: 502 });
      current = {
        ...current,
        mode: body.mode,
        hour: body.hour,
        timeZone: body.timeZone,
        revision: 1,
      };
      return HttpResponse.json({ revision: 1, changed: true, replayed: true });
    }),
  );
  const cache = createQueryClient();
  render(
    <QueryClientProvider client={cache}>
      <NotificationPreferencesPage scope={scope()} />
    </QueryClientProvider>,
  );
  const section = within(
    await screen.findByRole('region', { name: 'Your email' }),
  );
  await user.click(
    await section.findByRole('combobox', { name: 'Email frequency' }),
  );
  await user.click(await screen.findByRole('option', { name: 'Off' }));
  await user.click(section.getByRole('button', { name: 'Save choices' }));
  await screen.findByRole('button', { name: 'Retry same save' });
  expect(section.getByRole('combobox')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Retry same save' }));
  await screen.findByText('Notification choices saved');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
});
it('keeps a conflicted schedule draft until an explicit fresh reload', async () => {
  const user = userEvent.setup();
  let current = snapshot();
  mockServer.use(
    http.get(`${path}/preferences`, () => HttpResponse.json(current)),
    http.put(`${path}/preferences`, () => {
      current = { ...current, revision: 1, mode: 'hourly' };
      return HttpResponse.json(
        {
          type: 'https://pertexo.dev/problems/notifications.changed',
          title: 'Notification settings changed',
          status: 409,
          code: 'notifications.changed',
          requestId: 'notification-conflict-proof',
          detail: 'Reload current choices; your edits are kept.',
        },
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        },
      );
    }),
  );
  const cache = createQueryClient();
  render(
    <QueryClientProvider client={cache}>
      <NotificationPreferencesPage scope={scope()} />
    </QueryClientProvider>,
  );
  const section = within(
    await screen.findByRole('region', { name: 'Your email' }),
  );
  await user.click(
    await section.findByRole('combobox', { name: 'Email frequency' }),
  );
  await user.click(await screen.findByRole('option', { name: 'Daily digest' }));
  await user.clear(section.getByRole('textbox', { name: 'Time zone' }));
  await user.type(
    section.getByRole('textbox', { name: 'Time zone' }),
    'Europe/Paris',
  );
  await user.click(section.getByRole('button', { name: 'Save choices' }));
  await screen.findByText(/Someone changed these notification choices/u);
  await waitFor(() =>
    expect(
      section.getByRole('button', { name: 'Reload current choices' }),
    ).not.toBeDisabled(),
  );
  expect(section.getByRole('textbox', { name: 'Time zone' })).toHaveValue(
    'Europe/Paris',
  );
  await user.click(
    section.getByRole('button', { name: 'Reload current choices' }),
  );
  await waitFor(() =>
    expect(
      section.queryByRole('textbox', { name: 'Time zone' }),
    ).not.toBeInTheDocument(),
  );
  expect(section.getByRole('combobox')).toHaveTextContent('Hourly digest');
});
it('loads private subject choices only when opened and saves a follow independently of mute', async () => {
  const user = userEvent.setup();
  let reads = 0;
  let current = { revision: 0, followed: false, muted: false };
  const saved: unknown[] = [];
  mockServer.use(
    http.get(`${path}/subjects/workflow/${workflowId}`, () => {
      reads++;
      return HttpResponse.json(current);
    }),
    http.put(`${path}/subjects/workflow/${workflowId}`, async ({ request }) => {
      const body = (await request.json()) as {
        followed: boolean;
        muted: boolean;
      };
      saved.push(body);
      current = { revision: 1, followed: body.followed, muted: body.muted };
      return HttpResponse.json({ revision: 1, changed: true, replayed: false });
    }),
  );
  const cache = createQueryClient();
  render(
    <QueryClientProvider client={cache}>
      <NoticeSubjectActions
        scope={scope()}
        subject={{ subjectKind: 'workflow', subjectId: workflowId }}
        name="Import orders"
      />
    </QueryClientProvider>,
  );
  expect(reads).toBe(0);
  await user.click(
    screen.getByRole('button', { name: 'Personal notifications…' }),
  );
  await user.click(
    await screen.findByRole('checkbox', { name: 'Follow this workflow' }),
  );
  expect(
    screen.getByRole('checkbox', { name: 'Mute its notices for me' }),
  ).not.toBeChecked();
  await user.click(
    screen.getByRole('button', { name: 'Save personal choices' }),
  );
  await screen.findByText('Notification choices saved');
  expect(saved).toEqual([
    { expectedRevision: 0, followed: true, muted: false },
  ]);
});
it('keeps unsubscribe confirmation inert until an explicit button press and sends the capability only in its header', async () => {
  const user = userEvent.setup();
  const token = 'synthetic_unsubscribe_capability';
  const requests: Request[] = [];
  mockServer.use(
    http.post(
      'http://pertexo.test/v1/notifications/unsubscribe',
      ({ request }) => {
        requests.push(request);
        return HttpResponse.json({ unsubscribed: true });
      },
    ),
  );
  const { queryClient } = renderApp(`/notifications/unsubscribe#${token}`);
  const preferenceKey = notificationPreferencesQueryOptions(scope()).queryKey;
  queryClient.setQueryData(preferenceKey, {
    ...snapshot(),
    revision: 2,
    mode: 'immediate',
  });
  await screen.findByRole('heading', { name: 'Turn off personal email?' });
  expect(requests).toEqual([]);
  await user.click(
    screen.getByRole('button', {
      name: 'Turn off personal email',
    }),
  );
  await screen.findByText('Personal notification email is off');
  expect(queryClient.getQueryState(preferenceKey)?.isInvalidated).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    'http://pertexo.test/v1/notifications/unsubscribe',
  );
  expect(requests[0]?.headers.get('X-Pertexo-Unsubscribe-Key')).toBe(token);
});
