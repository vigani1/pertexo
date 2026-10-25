import { screen, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  api,
  installQueries,
  secondWorkflowId,
  summary,
  webhook,
  webhookId,
  workflowApi,
  workspaceId,
} from '../fixtures';

import { triggersPath } from './fixture';

describe('workflow triggers tab', () => {
  it('lists recent deliveries with what happened, admission status and the run', async () => {
    const runId = '77777777-7777-4777-8777-777777777777';
    const delivery = {
      receivedAt: new Date(Date.now() - 180_000).toISOString(),
      httpStatus: 202,
      signatureCheck: 'verified',
      replayCheck: 'new',
      byteLength: 321,
      runId: null,
    };
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({
          items: [{ ...webhook, status: 'active', endpointReady: true }],
        }),
      ),
      http.get(
        `${workflowApi}/triggers/${webhookId}/webhook/deliveries`,
        ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('after') === 'page-2'
              ? {
                  items: [
                    {
                      ...delivery,
                      id: 'aaaaaaaa-0000-4000-8000-000000000003',
                      outcome: 'authentication_failed',
                      httpStatus: 401,
                      signatureCheck: 'not_checked',
                      replayCheck: 'stale_timestamp',
                    },
                  ],
                  nextCursor: null,
                }
              : {
                  items: [
                    {
                      ...delivery,
                      id: 'aaaaaaaa-0000-4000-8000-000000000001',
                      outcome: 'accepted',
                      runId,
                    },
                    {
                      ...delivery,
                      id: 'aaaaaaaa-0000-4000-8000-000000000002',
                      outcome: 'authentication_failed',
                      httpStatus: 401,
                      signatureCheck: 'mismatch',
                      replayCheck: 'not_checked',
                      byteLength: null,
                    },
                  ],
                  nextCursor: 'page-2',
                },
          ),
      ),
    );
    renderApp(triggersPath);
    const hook = await screen.findByRole('article', {
      name: 'Webhook: Receive order',
    });
    const list = await within(hook).findByRole('list', {
      name: 'Recent deliveries',
    });
    const [accepted, rejected] = within(list).getAllByRole('listitem');
    if (accepted === undefined || rejected === undefined)
      throw new Error('Expected two delivery rows');
    expect(within(accepted).getByText('Accepted')).toBeVisible();
    expect(within(accepted).getByText('Admission 202 · 321 B')).toBeVisible();
    expect(
      within(accepted).getByRole('link', { name: 'Open run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);
    expect(within(accepted).getByText(/ago/u).closest('time')).toHaveAttribute(
      'dateTime',
      delivery.receivedAt,
    );
    expect(within(rejected).getByText('Authentication failed')).toBeVisible();
    expect(within(rejected).getByText('Admission 401')).toBeVisible();
    expect(
      within(rejected).queryByRole('link', { name: 'Open run' }),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(
        within(hook).getByRole('button', { name: 'Load older deliveries' }),
      );
    expect(await within(list).findByText('Too old')).toBeVisible();
    expect(
      within(hook).queryByRole('button', { name: 'Load older deliveries' }),
    ).not.toBeInTheDocument();
  });
  it('says plainly when a ready endpoint has received nothing, and when the log fails', async () => {
    let failing = true;
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers`, () =>
        HttpResponse.json({
          items: [{ ...webhook, status: 'active', endpointReady: true }],
        }),
      ),
      http.get(`${workflowApi}/triggers/${webhookId}/webhook/deliveries`, () =>
        failing
          ? HttpResponse.json(
              {
                type: 'about:blank',
                title: 'Unavailable',
                status: 503,
                code: 'internal.unavailable',
              },
              { status: 503 },
            )
          : HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(triggersPath);
    const hook = await screen.findByRole('article', {
      name: 'Webhook: Receive order',
    });
    expect(
      await within(hook).findByText(
        'Recent deliveries couldn’t be loaded. Try again.',
      ),
    ).toBeVisible();
    failing = false;
    await userEvent
      .setup()
      .click(within(hook).getByRole('button', { name: 'Retry' }));
    expect(
      await within(hook).findByText(/Nothing has arrived yet/u),
    ).toBeVisible();
  });
  it('resets state and fences late credentials when the workflow changes', async () => {
    installQueries();
    let releaseCredentials: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseCredentials = resolve;
    });
    const secondApi = `${api}/workflows/${secondWorkflowId}`;
    mockServer.use(
      http.get(secondApi, () =>
        HttpResponse.json({
          workflow: {
            ...summary,
            id: secondWorkflowId,
            publishedVersionId: null,
          },
        }),
      ),
      http.get(`${secondApi}/versions`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.get(`${secondApi}/triggers/schedules`, () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get(`${secondApi}/triggers`, () => HttpResponse.json({ items: [] })),
      http.post(
        `${workflowApi}/triggers/${webhookId}/webhook/provision`,
        async () => {
          await blocked;
          return HttpResponse.json({
            trigger: { ...webhook, endpointReady: true, status: 'active' },
            replayed: false,
            endpointKey: 'late-endpoint-key'.padEnd(43, 'e'),
            signingSecret: 'late-signing-secret'.padEnd(43, 's'),
          });
        },
      ),
    );
    const { router } = renderApp(triggersPath);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Create endpoint' }),
    );
    await router.navigate({
      to: '/w/$workspaceId/workflows/$workflowId/triggers',
      params: { workspaceId, workflowId: secondWorkflowId },
    });
    releaseCredentials?.();
    expect(
      await screen.findByRole('heading', { name: 'Nothing is published yet' }),
    ).toBeVisible();
    expect(
      screen.queryByText('late-signing-secret'.padEnd(43, 's')),
    ).not.toBeInTheDocument();
  });
});
