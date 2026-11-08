import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderInRouter } from '../../support/render-in-router';
import { testFetch } from '../../support/render-app';
import { createApiClient } from '@/lib/api/client';
import { FailureAlertsSection } from '@/features/workflow-settings/components/settings/failure-alerts-section';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { workspaceWith } from '../workflows/list/fixtures';
import {
  destination,
  installQueries,
  workflowApi,
  userId,
  workflowId,
} from './fixtures';

it('keeps the exact alert-clear retry reachable after the current policy already shows Off', async () => {
  const { event, clears, sets } = mountAcceptedClear();
  const alerts = await screen.findByRole('region', { name: 'Failure alerts' });
  await event.click(
    await within(alerts).findByRole('button', { name: 'Turn alerts off' }),
  );
  await within(alerts).findByText(/aren’t announced anywhere/u);
  expect(
    within(alerts).getByRole('button', { name: 'Turn alerts off' }),
  ).toBeDisabled();
  await event.click(
    within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
  );
  await event.click(
    await screen.findByRole('option', { name: 'Email to alerts@example.test' }),
  );
  await event.click(
    await within(alerts).findByRole('button', {
      name: 'Retry same alert change',
    }),
  );
  await waitFor(() => {
    expect(clears).toHaveLength(2);
  });
  expect(clears[1]).toBe(clears[0]);
  await waitFor(() => {
    expect(
      within(alerts).queryByRole('button', { name: 'Retry same alert change' }),
    ).not.toBeInTheDocument();
  });
  expect(
    within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
  ).toHaveTextContent('Email to alerts@example.test');
  await event.click(
    within(alerts).getByRole('button', { name: 'Save destination' }),
  );
  await waitFor(() => {
    expect(sets).toHaveLength(1);
  });
  expect(sets[0]?.body).toEqual({ destinationId: destination.id });
  expect(sets[0]?.key).not.toBe(clears[0]);
});

it('requires an explicit new attempt after the exact clear retry expires and keeps the next destination', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const { event, clears, sets } = mountAcceptedClear('lose-all');
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    await event.click(
      await within(alerts).findByRole('button', { name: 'Turn alerts off' }),
    );
    await within(alerts).findByText(/aren’t announced anywhere/u);
    await event.click(
      within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
    );
    await event.click(
      await screen.findByRole('option', {
        name: 'Email to alerts@example.test',
      }),
    );
    now += 86_400_000;
    const retry = within(alerts).queryByRole('button', {
      name: 'Retry same alert change',
    });
    if (retry !== null) await event.click(retry);
    await within(alerts).findByText(/The retry window ended/u);
    expect(clears).toHaveLength(1);
    expect(sets).toHaveLength(0);
    await event.click(
      within(alerts).getByRole('button', { name: 'Start a new attempt' }),
    );
    expect(clears).toHaveLength(1);
    expect(sets).toHaveLength(0);
    expect(
      within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
    ).toHaveTextContent('Email to alerts@example.test');
    await event.click(
      within(alerts).getByRole('button', { name: 'Save destination' }),
    );
    await waitFor(() => {
      expect(sets).toHaveLength(1);
    });
    expect(sets[0]?.key).not.toBe(clears[0]);
  } finally {
    clock.mockRestore();
  }
});

function mountAcceptedClear(mode: 'lose-first' | 'lose-all' = 'lose-first') {
  installQueries();
  let current: typeof destination | null = destination;
  const clears: (string | null)[] = [];
  const sets: { key: string | null; body: unknown }[] = [];
  mockServer.use(
    http.get(`${workflowApi}/failure-notification-policy`, () =>
      HttpResponse.json({ destination: current }),
    ),
    http.delete(`${workflowApi}/failure-notification-policy`, ({ request }) => {
      clears.push(request.headers.get('idempotency-key'));
      current = null;
      return clears.length === 1 || mode === 'lose-all'
        ? HttpResponse.error()
        : new HttpResponse(null, { status: 204 });
    }),
    http.put(
      `${workflowApi}/failure-notification-policy`,
      async ({ request }) => {
        sets.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        current = destination;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  renderInRouter(
    <FailureAlertsSection
      apiClient={createApiClient({
        fetch: testFetch,
        readCsrfToken: () =>
          'csrf-token-for-component-tests-12345678901234567890',
      })}
      userId={userId}
      workspace={accessibleWorkspaceSchema.parse(
        workspaceWith(['workflow:update']),
      )}
      workflowId={workflowId}
    />,
  );
  const event = userEvent.setup();
  return { event, clears, sets };
}
