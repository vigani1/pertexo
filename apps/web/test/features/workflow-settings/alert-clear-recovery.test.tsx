import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
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

it('reviews the current policy after an unknown clear and confirms a new destination without resending the clear', async () => {
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
  expect(sets[0]?.body).toEqual({ destinationId: destination.id });
  expect(sets[0]?.key).not.toBe(clears[0]);
});

// The refreshed policy doesn't show the clear, so its held key can't stand
// for the current state; clearing again is a fresh, harmless clear.
it('clears again under a new key when the refreshed policy still shows alerts on', async () => {
  const { event, clears } = mountAcceptedClear('keeps-current');
  const alerts = await screen.findByRole('region', { name: 'Failure alerts' });
  await event.click(
    await within(alerts).findByRole('button', { name: 'Turn alerts off' }),
  );
  await within(alerts).findByText(/couldn’t confirm/u);
  expect(clears).toHaveLength(1);
  expect(within(alerts).getByText('Failures go to')).toBeVisible();
  await event.click(
    within(alerts).getByRole('button', { name: 'Turn alerts off' }),
  );
  await within(alerts).findByText(/aren’t announced anywhere/u);
  expect(clears).toHaveLength(2);
  expect(clears[1]).not.toEqual(clears[0]);
});

it('sets a destination again under a new key once someone else undid the unconfirmed set', async () => {
  installQueries();
  let current: typeof destination | null = null;
  const sets: (string | null)[] = [];
  mockServer.use(
    http.get(`${workflowApi}/failure-notification-policy`, () =>
      HttpResponse.json({ destination: current }),
    ),
    http.put(`${workflowApi}/failure-notification-policy`, ({ request }) => {
      sets.push(request.headers.get('idempotency-key'));
      if (sets.length === 1) {
        // The set lands, its answer is lost, and another admin clears it
        // before the page reads the policy again.
        current = null;
        return HttpResponse.error();
      }
      current = destination;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderSection();
  const event = userEvent.setup();
  const alerts = await screen.findByRole('region', { name: 'Failure alerts' });
  const choose = async () => {
    await event.click(
      within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
    );
    await event.click(
      await screen.findByRole('option', {
        name: 'Email to alerts@example.test',
      }),
    );
    await event.click(
      within(alerts).getByRole('button', { name: 'Save destination' }),
    );
  };
  await within(alerts).findByRole('combobox', {
    name: 'Send failure alerts to',
  });
  await choose();
  await within(alerts).findByText(/Saving it again is safe/u);
  await choose();
  await within(alerts).findByText('Failures go to');
  expect(sets).toHaveLength(2);
  // A replay of the first key would report success while alerts stay off.
  expect(sets[1]).not.toEqual(sets[0]);
  expect(current).toEqual(destination);
});

it('replays the first set, not a second, while the policy can’t be read', async () => {
  installQueries();
  let current: typeof destination | null = null;
  let lost = false;
  const sets: (string | null)[] = [];
  const applied: (string | null)[] = [];
  mockServer.use(
    http.get(`${workflowApi}/failure-notification-policy`, () =>
      lost
        ? HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Unavailable',
              status: 503,
              code: 'internal.unavailable',
            },
            { status: 503 },
          )
        : HttpResponse.json({ destination: current }),
    ),
    http.put(`${workflowApi}/failure-notification-policy`, ({ request }) => {
      const key = request.headers.get('idempotency-key');
      sets.push(key);
      // A key the server has seen replays its receipt; it never reapplies.
      if (!applied.includes(key)) {
        applied.push(key);
        current = destination;
      }
      if (sets.length === 1) {
        // The set lands, its answer is lost, and the next read fails too.
        lost = true;
        return HttpResponse.error();
      }
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderSection();
  const event = userEvent.setup();
  const alerts = await screen.findByRole('region', { name: 'Failure alerts' });
  const choose = async () => {
    await event.click(
      within(alerts).getByRole('combobox', { name: 'Send failure alerts to' }),
    );
    await event.click(
      await screen.findByRole('option', {
        name: 'Email to alerts@example.test',
      }),
    );
    await event.click(
      within(alerts).getByRole('button', { name: 'Save destination' }),
    );
  };
  await within(alerts).findByRole('combobox', {
    name: 'Send failure alerts to',
  });
  await choose();
  await within(alerts).findByText(/Saving it again is safe/u);
  await choose();
  await waitFor(() => {
    expect(sets).toHaveLength(2);
  });
  // Nothing showed the set missing, so the second save replays the first.
  expect(sets[1]).toEqual(sets[0]);
  expect(applied).toHaveLength(1);
});

function mountAcceptedClear(
  mode: 'lose-first' | 'keeps-current' = 'lose-first',
) {
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
      if (clears.length > 1 || mode !== 'keeps-current') current = null;
      return clears.length === 1
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
  renderSection();
  const event = userEvent.setup();
  return { event, clears, sets };
}

function renderSection() {
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
}
