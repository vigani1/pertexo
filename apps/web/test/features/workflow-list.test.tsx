import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { statisticsHandler } from '../support/run-fixtures';
import {
  api,
  discoveryHandlers,
  draftHandler,
  graphOf,
  problem,
  secondWorkflowId,
  summary,
  thirdWorkflowId,
  versionId,
  workflowId,
  workspaceId,
} from './workflow-list.fixtures';

function listHandler(pages: (after: string | null) => Record<string, unknown>) {
  return http.get(`${api}/workflows`, ({ request }) =>
    HttpResponse.json(pages(new URL(request.url).searchParams.get('after'))),
  );
}

describe('workflow list', () => {
  it('returns to login when the session expires during scoped discovery', async () => {
    let userReads = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        userReads += 1;
        if (userReads === 1)
          return HttpResponse.json({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            email: 'owner@example.test',
            displayName: 'Workspace Owner',
            status: 'active',
            createdAt: '2026-09-14T10:00:00.000Z',
            updatedAt: '2026-09-14T10:00:00.000Z',
          });
        return problem(401, 'auth.unauthenticated');
      }),
      http.get(`${api}/workflows`, () => problem(401, 'auth.unauthenticated')),
      ...discoveryHandlers(),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
  });

  it('loads real pages newest first and appends the next cursor page', async () => {
    const orders: (string | null)[] = [];
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, ({ request }) => {
        const url = new URL(request.url);
        orders.push(url.searchParams.get('order'));
        return HttpResponse.json(
          url.searchParams.get('after') === null
            ? {
                items: [summary(workflowId, 'Daily intake')],
                nextCursor: 'two',
              }
            : {
                items: [summary(secondWorkflowId, 'Incident response')],
                nextCursor: null,
              },
        );
      }),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('Daily intake')).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Workflows' }).closest('header'),
    ).toHaveTextContent('1+ workflows');
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Incident response')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
    expect(orders.every((order) => order === 'updated_desc')).toBe(true);
  });

  it('keeps the first page and retries only the failed next page', async () => {
    let nextPageAttempts = 0;
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, ({ request }) => {
        if (new URL(request.url).searchParams.get('after') === null)
          return HttpResponse.json({
            items: [summary(workflowId, 'Daily intake')],
            nextCursor: 'two',
          });
        nextPageAttempts += 1;
        if (nextPageAttempts === 1) return HttpResponse.error();
        return HttpResponse.json({
          items: [summary(secondWorkflowId, 'Incident response')],
          nextCursor: null,
        });
      }),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    expect(await screen.findByText('Daily intake')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'More workflows couldn’t be loaded',
    );
    expect(screen.getByText('Daily intake')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry next page' }));
    expect(await screen.findByText('Incident response')).toBeVisible();
    expect(nextPageAttempts).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('describes each row with a state word, its path and triggers, never its ID', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler({
        [workflowId]: graphOf([
          { id: 'hook', key: 'core.webhook', x: 0 },
          { id: 'check', key: 'core.validate', x: 280 },
          { id: 'erp', key: 'http.request', label: 'Post to ERP', x: 560 },
        ]),
      }),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Invoice intake', {
            activationStatus: 'active',
            publishedVersionId: versionId,
          }),
          summary(secondWorkflowId, 'Nightly sync', {
            activationStatus: 'degraded',
            publishedVersionId: versionId,
          }),
          summary(thirdWorkflowId, 'Onboarding email'),
        ],
        nextCursor: null,
      })),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    const list = await screen.findByRole('list', { name: 'Workflows' });
    const invoice = within(list).getByText('Invoice intake').closest('li');
    if (invoice === null) throw new Error('Expected the invoice row');
    expect(
      await within(invoice).findByText('Webhook → Validate → Post to ERP'),
    ).toBeVisible();
    expect(within(invoice).getAllByText('Live')[0]).toBeInTheDocument();
    expect(
      within(invoice).getAllByText('Triggers: Webhook')[0],
    ).toBeInTheDocument();
    expect(within(list).getAllByText('Degraded')[0]).toBeInTheDocument();
    expect(within(list).getAllByText('Draft')[0]).toBeInTheDocument();
    expect(await within(list).findAllByText('No steps yet')).toHaveLength(2);
    expect(list).not.toHaveTextContent(workflowId);
    const header = screen
      .getByRole('heading', { name: 'Workflows' })
      .closest('header');
    expect(header).toHaveTextContent('3 workflows');
    expect(header).toHaveTextContent('1 degraded');
    expect(header).toHaveTextContent('1 draft');
    expect(
      within(invoice).getByRole('link', { name: 'Invoice intake' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
  });

  it('sorts on the server and filters loaded workflows by name and view', async () => {
    const orders: (string | null)[] = [];
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, ({ request }) => {
        orders.push(new URL(request.url).searchParams.get('order'));
        return HttpResponse.json({
          items: [
            summary(workflowId, 'Daily intake'),
            summary(secondWorkflowId, 'Old report', {
              lifecycleStatus: 'archived',
            }),
            summary(thirdWorkflowId, 'Incident response'),
          ],
          nextCursor: null,
        });
      }),
    );
    const { router } = renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Workflows' });
    expect(within(list).queryByText('Old report')).not.toBeInTheDocument();

    await event.keyboard('/');
    const filter = screen.getByRole('searchbox', {
      name: 'Filter workflows by name',
    });
    expect(filter).toHaveFocus();
    await event.type(filter, 'INC');
    expect(within(list).getByText('Incident response')).toBeVisible();
    expect(within(list).queryByText('Daily intake')).not.toBeInTheDocument();

    await event.clear(filter);
    await event.click(screen.getByRole('button', { name: /^Archived/u }));
    expect(
      await within(
        await screen.findByRole('list', { name: 'Workflows' }),
      ).findByText('Old report'),
    ).toBeVisible();
    expect(router.state.location.search).toMatchObject({ view: 'archived' });

    await event.click(screen.getByRole('combobox', { name: 'Sort workflows' }));
    await event.click(
      await screen.findByRole('option', { name: 'Oldest first' }),
    );
    await waitFor(() => {
      expect(orders).toContain('created_asc');
    });
    expect(router.state.location.search).toMatchObject({
      view: 'archived',
      sort: 'created',
    });
  });

  it('draws run strips from the latest workspace runs, grouped by workflow', async () => {
    const run = (
      id: string,
      workflow: string,
      status: string,
      minute: number,
    ) => ({
      id,
      workspaceId,
      workflowId: workflow,
      workflowVersionId: versionId,
      status,
      triggerType: 'manual',
      createdAt: `2026-09-14T10:${String(minute).padStart(2, '0')}:00.000Z`,
      updatedAt: '2026-09-14T11:00:00.000Z',
      startedAt: null,
      completedAt: null,
      deadlineAt: null,
      cancelRequestedAt: null,
    });
    mockServer.use(
      ...discoveryHandlers(['workflow:create', 'run:read']),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Invoice intake'),
          summary(secondWorkflowId, 'Nightly sync'),
        ],
        nextCursor: null,
      })),
      statisticsHandler(),
      http.get(`${api}/runs`, () =>
        HttpResponse.json({
          items: [
            run(
              '11111111-1111-4111-8111-111111111111',
              workflowId,
              'failed',
              3,
            ),
            run(
              '22222222-2222-4222-8222-222222222222',
              workflowId,
              'succeeded',
              2,
            ),
            run(
              '33333333-3333-4333-8333-333333333333',
              workflowId,
              'succeeded',
              1,
            ),
          ],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('img', {
        name: 'Recent runs: 2 succeeded, 1 failed',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('None recently')).toBeInTheDocument();
    expect(
      screen.getByText(/among the latest 3 runs in this workspace/u),
    ).toBeVisible();
  });

  it('archives from the row menu after spelling out the consequences', async () => {
    const requests: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...discoveryHandlers(['workflow:create', 'workflow:publish']),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Invoice intake', { lifecycleRevision: 4 }),
        ],
        nextCursor: null,
      })),
      http.post(
        `${api}/workflows/${workflowId}/archive`,
        async ({ request }) => {
          requests.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          return HttpResponse.json({
            workflow: summary(workflowId, 'Invoice intake', {
              lifecycleStatus: 'archived',
              lifecycleRevision: 5,
            }),
            replayed: false,
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Actions for Invoice intake' }),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Triggers' }),
    ).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/triggers`,
    );
    await event.click(screen.getByRole('menuitem', { name: 'Archive…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Archive this workflow?',
    });
    expect(dialog).toHaveTextContent(
      'Runs already in progress finish normally.',
    );
    await event.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Workflow archived')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[0]?.body).toEqual({ expectedLifecycleRevision: 4 });
  });

  it('keeps archive out of the menu for people who can’t publish', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      listHandler(() => ({
        items: [summary(workflowId, 'Invoice intake')],
        nextCursor: null,
      })),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Actions for Invoice intake',
      }),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Copy ID' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Archive…' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Runs' }),
    ).not.toBeInTheDocument();
  });

  it('explains a failed first load and recovers on retry', async () => {
    let reads = 0;
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, () => {
        reads += 1;
        // The route's read and the page's mount retry both fail.
        return reads <= 2
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json({
              items: [summary(workflowId, 'Daily intake')],
              nextCursor: null,
            });
      }),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('heading', { name: 'Workflows didn’t load' }),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Daily intake')).toBeVisible();
  });
});
