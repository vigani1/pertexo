import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { workflowKeys } from '@/features/workflows/queries.public';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  api,
  destination,
  destinationId,
  installQueries,
  problem,
  summary,
  userId,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const settingsPath = `/w/${workspaceId}/workflows/${workflowId}/settings`;
const detailKey = workflowKeys.detail(userId, workspaceId, workflowId);

/** Sections stay queryable behind an open modal, which hides them from AT. */
function region(name: string) {
  return screen.getByRole('region', { name, hidden: true });
}

describe('workflow settings tab', () => {
  it('shows identity and archives with its consequences spelled out', async () => {
    const requests: { key: string | null; body: unknown }[] = [];
    installQueries();
    mockServer.use(
      http.post(`${workflowApi}/archive`, async ({ request }) => {
        requests.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        return HttpResponse.json({
          workflow: {
            ...summary,
            lifecycleStatus: 'archived',
            lifecycleRevision: 8,
          },
          replayed: false,
        });
      }),
    );
    const { queryClient } = renderApp(settingsPath);
    const event = userEvent.setup();
    const identity = await screen.findByRole('region', { name: 'Identity' });
    expect(await within(identity).findByText('Daily control')).toBeVisible();
    expect(within(identity).getByText(workflowId)).toBeVisible();
    expect(
      within(identity).getByRole('button', { name: 'Copy workflow ID' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Back to editor' }),
    ).not.toBeInTheDocument();
    queryClient.setQueryData(workflowKeys.recent(userId, workspaceId), {
      items: [summary],
      nextCursor: null,
    });

    await event.click(
      within(region('Lifecycle')).getByRole('button', {
        name: 'Archive workflow',
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Archive this workflow?',
    });
    expect(dialog).toHaveTextContent('New runs stop');
    await event.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Workflow archived')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[0]?.body).toEqual({ expectedLifecycleRevision: 7 });
    expect(
      queryClient.getQueryState(workflowKeys.recent(userId, workspaceId))
        ?.isInvalidated,
    ).toBe(true);
  });

  it('retains the exact lifecycle command across an uncertain retry and refreshed status', async () => {
    installQueries();
    const requests: { path: string; key: string; body: unknown }[] = [];
    let currentSummary = summary;
    mockServer.use(
      http.get(workflowApi, () =>
        HttpResponse.json({ workflow: currentSummary }),
      ),
      http.post(`${workflowApi}/archive`, async ({ request }) => {
        requests.push({
          path: 'archive',
          key: request.headers.get('idempotency-key') ?? '',
          body: await request.json(),
        });
        currentSummary = {
          ...summary,
          lifecycleStatus: 'archived',
          lifecycleRevision: 8,
        };
        if (requests.length === 1) return HttpResponse.error();
        return HttpResponse.json({ workflow: currentSummary, replayed: true });
      }),
      http.post(`${workflowApi}/restore`, async ({ request }) => {
        requests.push({
          path: 'restore',
          key: request.headers.get('idempotency-key') ?? '',
          body: await request.json(),
        });
        currentSummary = { ...summary, lifecycleRevision: 9 };
        return HttpResponse.json({ workflow: currentSummary, replayed: false });
      }),
    );
    const { queryClient } = renderApp(settingsPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    currentSummary = {
      ...summary,
      lifecycleStatus: 'archived',
      lifecycleRevision: 8,
    };
    await queryClient.refetchQueries({ queryKey: detailKey });
    expect(
      screen.getByRole('heading', { name: 'Archive this workflow?' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: /^Archive$/u }));
    expect(
      await screen.findByText(
        /couldn’t confirm whether archiving went through/u,
      ),
    ).toBeVisible();
    await queryClient.refetchQueries({ queryKey: detailKey });
    expect(
      screen.getByRole('heading', { name: 'Archive this workflow?' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry safely' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Archive this workflow?' }),
      ).not.toBeInTheDocument();
    });
    expect(requests.map((request) => request.path)).toEqual([
      'archive',
      'archive',
    ]);
    expect(requests[0]?.body).toEqual({ expectedLifecycleRevision: 7 });
    expect(requests[1]?.body).toEqual({ expectedLifecycleRevision: 7 });
    expect(requests[0]?.key).toBe(requests[1]?.key);

    await event.click(
      await screen.findByRole('button', { name: 'Restore workflow' }),
    );
    await event.click(screen.getByRole('button', { name: /^Restore$/u }));
    await waitFor(() => {
      expect(requests[2]).toMatchObject({
        path: 'restore',
        body: { expectedLifecycleRevision: 8 },
      });
    });
    expect(requests[2]?.key).not.toBe(requests[0]?.key);
  });

  it('removes lifecycle details and an open confirmation after an authoritative unavailable refresh', async () => {
    installQueries();
    const { queryClient } = renderApp(settingsPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    expect(
      screen.getByRole('heading', { name: 'Archive this workflow?' }),
    ).toBeVisible();
    mockServer.use(
      http.get(workflowApi, () => problem(404, 'resource.not_found')),
    );
    await queryClient.refetchQueries({ queryKey: detailKey });
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Archive this workflow?' }),
      ).not.toBeInTheDocument();
    });
    expect(
      within(region('Identity')).queryByText('Daily control'),
    ).not.toBeInTheDocument();
    expect(
      within(region('Lifecycle')).getByText(/This isn’t available to you/u),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Archive workflow' }),
    ).not.toBeInTheDocument();
  });

  it('keeps lifecycle details and the confirmation through a transient refresh failure', async () => {
    installQueries();
    const { queryClient } = renderApp(settingsPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Archive workflow' }),
    );
    mockServer.use(
      http.get(workflowApi, () => HttpResponse.json({}, { status: 500 })),
    );
    await queryClient.refetchQueries({ queryKey: detailKey });
    expect(
      (
        await screen.findAllByText(/Couldn’t refresh. Showing results from/u)
      )[0],
    ).toBeVisible();
    expect(within(region('Identity')).getByText('Daily control')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Archive this workflow?' }),
    ).toBeVisible();

    installQueries();
    await queryClient.refetchQueries({ queryKey: detailKey });
    await waitFor(() => {
      expect(
        screen.queryByText(/Couldn’t refresh. Showing results from/u),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { name: 'Archive this workflow?' }),
    ).toBeVisible();
  });

  it('shows the current choice, then sends alerts to a destination chosen by its human label', async () => {
    const keys: (string | null)[] = [];
    let current: typeof destination | null = null;
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/failure-notification-policy`, () =>
        HttpResponse.json({ destination: current }),
      ),
      http.put(
        `${workflowApi}/failure-notification-policy`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key'));
          expect(await request.json()).toEqual({ destinationId });
          current = destination;
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    renderApp(settingsPath);
    const event = userEvent.setup();
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    expect(
      await within(alerts).findByText(/aren’t announced anywhere/u),
    ).toBeVisible();
    expect(
      within(alerts).queryByText(/can’t show the current choice/u),
    ).not.toBeInTheDocument();
    expect(
      within(alerts).getByRole('button', { name: 'Turn alerts off' }),
    ).toBeDisabled();
    expect(
      within(alerts).getByRole('link', { name: 'Manage alert destinations' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/alerts`);
    await event.click(
      await within(alerts).findByRole('combobox', {
        name: 'Send failure alerts to',
      }),
    );
    await event.click(
      await screen.findByRole('option', {
        name: 'Email to alerts@example.test',
      }),
    );
    await event.click(
      within(alerts).getByRole('button', { name: 'Save destination' }),
    );
    expect(await screen.findByText('Failure alerts updated')).toBeVisible();
    expect(keys).toEqual([expect.any(String)]);
    const now = await within(alerts).findByText('Failures go to');
    expect(now.parentElement).toHaveTextContent(
      'Failures go toEmail to alerts@example.test',
    );
    expect(
      within(alerts).getByRole('button', { name: 'Turn alerts off' }),
    ).toBeEnabled();
  });

  it('says plainly when the current alert destination is turned off', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/failure-notification-policy`, () =>
        HttpResponse.json({
          destination: { ...destination, status: 'disabled' },
        }),
      ),
    );
    renderApp(settingsPath);
    const alerts = await screen.findByRole('region', {
      name: 'Failure alerts',
    });
    expect(
      await within(alerts).findByText(
        'Failures go to: Email to alerts@example.test',
      ),
    ).toBeVisible();
    expect(
      within(alerts).getByText(/turned off, so nothing is sent/u),
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
