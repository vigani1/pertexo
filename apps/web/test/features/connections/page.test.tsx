import { screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import {
  base,
  connection,
  connectionId,
  detailOf,
  identityHandlers,
  lens,
  listOf,
  testedOk,
  userId,
  workspace,
  workspaceId,
} from './page/fixture';

describe('connections page', () => {
  it('shows run rejection, explicit recovery and bounded historical/archived usage pages in the same detail lens', async () => {
    const reads: URL[] = [];
    let current = connection('Primary Slack', {
      status: 'reauthorization_required',
      health: {
        lastTestedAt: null,
        lastHealthyAt: null,
        lastErrorCode: 'connection.slack_token_expired',
        lastRunObservedAt: '2026-09-15T11:00:00.000Z',
        lastHealthTransitionAt: '2026-09-15T11:00:00.000Z',
        lastHealthTransitionSource: 'run',
      },
    });
    const row = {
      workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      workflowName: 'Incident workflow',
      workflowLifecycleStatus: 'active',
      workflowVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      versionNumber: 2,
      isCurrentPublication: true,
      operationKeys: ['slack.send_message'],
    };
    mockServer.use(
      ...identityHandlers(workspace, false),
      listOf(() => [current]),
      detailOf(() => current),
      http.get(`${base}/${connectionId}/usage`, ({ request }) => {
        const url = new URL(request.url);
        reads.push(url);
        return HttpResponse.json(
          url.searchParams.has('after')
            ? {
                items: [
                  {
                    ...row,
                    workflowVersionId: '11111111-1111-4111-8111-111111111111',
                    versionNumber: 1,
                    isCurrentPublication: false,
                    workflowLifecycleStatus: 'archived',
                  },
                ],
                nextCursor: null,
              }
            : { items: [row], nextCursor: 'older-page' },
        );
      }),
      http.post(`${base}/${connectionId}/test`, () => {
        current = connection('Primary Slack', {
          health: {
            lastTestedAt: '2026-09-15T12:00:00.000Z',
            lastHealthyAt: '2026-09-15T12:00:00.000Z',
            lastErrorCode: null,
            lastRunObservedAt: '2026-09-15T11:00:00.000Z',
            lastHealthTransitionAt: '2026-09-15T12:00:00.000Z',
            lastHealthTransitionSource: 'test',
          },
        });
        return testedOk(current);
      }),
    );
    renderApp(`/w/${workspaceId}/connections?connection=${connectionId}`);
    expect(
      await screen.findByRole('heading', { name: 'Primary Slack' }),
    ).toBeVisible();
    expect(lens().getByText('Needs reauthorization')).toBeVisible();
    expect(
      lens().getByText('run credential rejected · Slack token expired'),
    ).toBeVisible();
    expect(
      lens().getByText('Last tested').nextElementSibling,
    ).toHaveTextContent('Never');
    expect(lens().getByText('From a workflow run')).toBeVisible();
    expect(await lens().findByText('Live as version 2')).toBeVisible();
    await userEvent
      .setup()
      .click(lens().getByRole('button', { name: 'Load more' }));
    expect(
      // Both versions belong to one workflow, so they share its row.
      await lens().findByText(
        'Live as version 2, 1 older version still used by runs (archived workflow)',
      ),
    ).toBeVisible();
    expect(
      reads.map((url) => [
        url.searchParams.get('limit'),
        url.searchParams.get('after'),
      ]),
    ).toEqual([
      ['50', null],
      ['50', 'older-page'],
    ]);
    await userEvent.setup().click(lens().getByRole('button', { name: 'Test' }));
    await userEvent
      .setup()
      .click(lens().getByRole('button', { name: 'Test connection' }));
    expect(await lens().findByText('Healthy')).toBeVisible();
    await userEvent
      .setup()
      .click(lens().getByRole('button', { name: 'Back to details' }));
    expect(lens().getByText('From an explicit test')).toBeVisible();
  });
  it('suppresses used-by reads without workflow-read authority while retaining authorized connection actions', async () => {
    let usageReads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: ['workspace:read', 'connection:read', 'connection:use'],
      }),
      listOf(() => [connection('Primary Slack')]),
      detailOf(() => connection('Primary Slack')),
      http.get(`${base}/${connectionId}/usage`, () => {
        usageReads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderApp(`/w/${workspaceId}/connections?connection=${connectionId}`);
    expect(
      await screen.findByText(
        'Workflow-read permission is needed to see usage.',
      ),
    ).toBeVisible();
    expect(lens().getByRole('button', { name: 'Test' })).toBeVisible();
    expect(
      lens().queryByRole('button', { name: 'Replace credential' }),
    ).not.toBeInTheDocument();
    expect(usageReads).toBe(0);
  });
  it('keeps data through a failed refresh and hides it after a nondisclosing 404', async () => {
    let response: 'ok' | 'failed' | 'unavailable' = 'ok';
    mockServer.use(
      ...identityHandlers(),
      http.get(base, () => {
        if (response === 'failed') return HttpResponse.error();
        if (response === 'unavailable')
          return HttpResponse.json(
            {
              type: 'urn:pertexo:problem:resource.not_found',
              title: 'Resource not found',
              status: 404,
              code: 'resource.not_found',
              requestId: 'request-connections-not-found',
            },
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        return HttpResponse.json({
          items: [connection('Primary Slack')],
          nextCursor: null,
        });
      }),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Primary Slack')).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('never tested')).toBeVisible();

    response = 'failed';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'connections'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn’t refresh. Showing results from/u,
    );
    expect(screen.getByText('Primary Slack')).toBeVisible();

    response = 'ok';
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    response = 'unavailable';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'connections'],
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Connections are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add connection' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Primary Slack')).not.toBeInTheDocument();
  });
  it('paginates safe connection metadata and shows health in words', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(base, ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('after') === null
            ? {
                items: [
                  connection('Primary Slack', {
                    status: 'reauthorization_required',
                    health: {
                      lastTestedAt: '2026-09-15T11:00:00.000Z',
                      lastHealthyAt: null,
                      lastErrorCode: 'connection.credential_rejected',
                    },
                  }),
                ],
                nextCursor: 'next',
              }
            : {
                items: [
                  connection('Incident Slack', {
                    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                  }),
                ],
                nextCursor: null,
              },
        ),
      ),
    );

    renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Primary Slack')).toBeVisible();
    expect(screen.getByText('last test failed · invalid token')).toBeVisible();
    expect(screen.getByText('1 needs reconnecting')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Incident Slack')).toBeVisible();
    expect(screen.queryByText(/xoxb-/u)).not.toBeInTheDocument();
    expect(screen.queryByText(connectionId)).not.toBeInTheDocument();
  });
});
