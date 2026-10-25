import { screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { createUserFixture } from '../../../support/fixtures/identity';

import { statisticsHandler } from '../../../support/fixtures/run';

import { mockServer } from '../../../support/mock-server';

import { expectSignInPage, renderApp } from '../../../support/render-app';

import {
  api,
  discoveryHandlers,
  draftHandler,
  graphOf,
  organizedPage,
  problem,
  secondWorkflowId,
  summary,
  thirdWorkflowId,
  versionId,
  workflowId,
  workspaceId,
} from './fixtures';

import { listHandler } from './page/fixture';

describe('workflow list', () => {
  it('returns to login when the session expires during scoped discovery', async () => {
    let userReads = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        userReads += 1;
        if (userReads === 1)
          return HttpResponse.json(
            createUserFixture({
              email: 'owner@example.test',
              displayName: 'Workspace Owner',
              createdAt: '2026-09-14T10:00:00.000Z',
              updatedAt: '2026-09-14T10:00:00.000Z',
            }),
          );
        return problem(401, 'auth.unauthenticated');
      }),
      http.get(`${api}/workflows`, () => problem(401, 'auth.unauthenticated')),
      ...discoveryHandlers(),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    await expectSignInPage();
  });
  it('shows webhook setup from the summary without reading trigger credentials', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Incoming orders', {
            activationStatus: 'activating',
            publishedVersionId: versionId,
            webhookSetupRequired: true,
          }),
        ],
        nextCursor: null,
      })),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('Trigger needs setup')).toBeVisible();
    expect(
      screen.queryByText('Starting', { exact: true }),
    ).not.toBeInTheDocument();
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
          organizedPage(
            url.searchParams.get('after') === null
              ? {
                  items: [summary(workflowId, 'Daily intake')],
                  nextCursor: 'two',
                }
              : {
                  items: [summary(secondWorkflowId, 'Incident response')],
                  nextCursor: null,
                },
          ),
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
  it('explains what each workflow state means from the header', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      listHandler(() => ({
        items: [summary(workflowId, 'Daily intake')],
        nextCursor: null,
      })),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('Daily intake')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'What these mean' }));
    const guide = await screen.findByRole('dialog', {
      name: 'What these mean',
    });
    expect(within(guide).getByText('Degraded')).toBeVisible();
    expect(
      within(guide).getByText(/Its last 20 runs, oldest on the left/u),
    ).toBeVisible();
  });
  it('keeps the first page and retries only the failed next page', async () => {
    let nextPageAttempts = 0;
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, ({ request }) => {
        if (new URL(request.url).searchParams.get('after') === null)
          return HttpResponse.json(
            organizedPage({
              items: [summary(workflowId, 'Daily intake')],
              nextCursor: 'two',
            }),
          );
        nextPageAttempts += 1;
        if (nextPageAttempts === 1) return HttpResponse.error();
        return HttpResponse.json(
          organizedPage({
            items: [summary(secondWorkflowId, 'Incident response')],
            nextCursor: null,
          }),
        );
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
            webhookSetupRequired: false,
            publishedVersionId: versionId,
          }),
          summary(secondWorkflowId, 'Nightly sync', {
            activationStatus: 'degraded',
            webhookSetupRequired: false,
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
    // Workflows without steps draw the empty thread, not a blank gap.
    expect(
      list.querySelectorAll('[data-slot="pattern-glyph"][data-state="empty"]'),
    ).toHaveLength(2);
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
  it('draws each workflow’s strip from its own latest runs', async () => {
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
    const reads: { workflowId: string | null; limit: string | null }[] = [];
    const runsOf: Record<string, unknown[]> = {
      [workflowId]: [
        run('11111111-1111-4111-8111-111111111111', workflowId, 'failed', 3),
        run('22222222-2222-4222-8222-222222222222', workflowId, 'succeeded', 2),
        run('33333333-3333-4333-8333-333333333333', workflowId, 'succeeded', 1),
      ],
      // A quiet workflow still shows its one run, however busy the other.
      [secondWorkflowId]: [
        run(
          '44444444-4444-4444-8444-444444444444',
          secondWorkflowId,
          'succeeded',
          0,
        ),
      ],
    };
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
      http.get(`${api}/runs`, ({ request }) => {
        const url = new URL(request.url);
        const workflow = url.searchParams.get('workflowId');
        reads.push({
          workflowId: workflow,
          limit: url.searchParams.get('limit'),
        });
        return HttpResponse.json({
          items: workflow === null ? [] : (runsOf[workflow] ?? []),
          nextCursor: null,
        });
      }),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('img', {
        name: 'Recent runs: 2 succeeded, 1 failed',
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: 'Recent runs: 1 succeeded' }),
    ).toBeInTheDocument();
    expect(reads).toEqual(
      expect.arrayContaining([
        { workflowId, limit: '20' },
        { workflowId: secondWorkflowId, limit: '20' },
      ]),
    );
    expect(screen.queryByText(/Recent runs covers/u)).not.toBeInTheDocument();
  });
  it('says a workflow that hasn’t run has no recent runs', async () => {
    mockServer.use(
      ...discoveryHandlers(['workflow:create', 'run:read']),
      draftHandler(),
      listHandler(() => ({
        items: [summary(workflowId, 'Invoice intake')],
        nextCursor: null,
      })),
      http.get(`${api}/runs`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
  });
});
