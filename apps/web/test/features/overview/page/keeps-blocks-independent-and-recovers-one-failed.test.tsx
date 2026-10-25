import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { coldStart, identityHandlers } from '../../../support/fixtures/run';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  connectionId,
  readerCapabilities,
  runHandlers,
  timestamp,
  workflow,
  workflowHandlers,
  workflowId,
  workspaceId,
} from './fixture';

describe('workspace home', () => {
  it('keeps blocks independent and recovers one failed read', async () => {
    let failedReads = 0;
    let failing = true;
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers({
        // The warm-up read and any mount retry fail until Try again.
        failed: () => {
          failedReads += 1;
          return failing
            ? HttpResponse.json(
                {
                  type: 'urn:pertexo:problem:unexpected',
                  title: 'Unavailable',
                  status: 500,
                  code: 'unexpected',
                  requestId: 'home-failed-read',
                },
                { status: 500 },
              )
            : undefined;
        },
      }),
    );

    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    const retry = await within(attention).findByRole('button', {
      name: 'Try again',
    });
    const readsBeforeRetry = failedReads;
    failing = false;
    await userEvent.setup().click(retry);
    expect(screen.getByRole('link', { name: 'Daily intake' })).toBeVisible();
    expect(
      await within(attention).findByText(
        'Daily intake failed once in the last 24 hours',
      ),
    ).toBeVisible();
    expect(failedReads).toBe(readsBeforeRetry + 1);
  });
  it('does not read or show runs without run access', async () => {
    let runReads = 0;
    mockServer.use(
      ...identityHandlers(['workspace:read', 'workflow:read']),
      workflowHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () => {
        runReads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    renderApp(`/w/${workspaceId}`);
    expect(
      await screen.findByRole('link', { name: 'Daily intake' }, coldStart),
    ).toBeVisible();
    expect(screen.queryByRole('img', { name: /Timeline/u })).toBeNull();
    expect(
      screen.queryByRole('link', { name: 'Failed runs' }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(runReads).toBe(0);
    });
  });
  it('keeps the last result visible when a background refresh fails', async () => {
    let failedReads = 0;
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers({
        failed: () => {
          failedReads += 1;
          return failedReads === 2 ? HttpResponse.error() : undefined;
        },
      }),
    );

    renderApp(`/w/${workspaceId}`);
    const item = await screen.findByText(
      'Daily intake failed once in the last 24 hours',
      undefined,
      coldStart,
    );
    const event = userEvent.setup();
    await event.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByText(/Couldn’t refresh. Showing results from/u),
    ).toBeVisible();
    expect(item).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(
        screen.queryByText(/Couldn’t refresh. Showing results from/u),
      ).not.toBeInTheDocument();
    });
    expect(failedReads).toBe(3);
  });
  it('shows a single all-clear line when nothing needs attention', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers(),
      ...runHandlers({ problems: [] }),
    );

    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    expect(await within(attention).findByText('All clear.')).toBeVisible();
    expect(within(attention).getByText('Nothing needs you.')).toBeVisible();
  });
  it('lists unhealthy triggers and connections to reconnect with their fixes', async () => {
    mockServer.use(
      ...identityHandlers([
        ...readerCapabilities,
        'connection:read',
        'connection:manage',
      ]),
      workflowHandlers([workflow({ activationStatus: 'degraded' })]),
      ...runHandlers({ problems: [] }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () =>
          HttpResponse.json({
            items: [
              {
                id: connectionId,
                workspaceId,
                providerKey: 'slack',
                name: 'Finance bot',
                authType: 'slack_bot_token',
                status: 'reauthorization_required',
                secretVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                health: {
                  lastTestedAt: null,
                  lastHealthyAt: null,
                  lastErrorCode: null,
                },
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            nextCursor: null,
          }),
      ),
    );

    renderApp(`/w/${workspaceId}`);
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      coldStart,
    );
    expect(
      await within(attention).findByText('Daily intake is degraded'),
    ).toBeVisible();
    expect(
      within(attention).getByRole('link', { name: 'Check triggers' }),
    ).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/triggers`,
    );
    expect(
      await within(attention).findByText('Finance bot needs reconnecting'),
    ).toBeVisible();
    expect(
      within(attention).getByRole('link', { name: 'Reconnect' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/connections`);
  });
  it('guides a new workspace with its first-thread checklist instead of the loom', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      workflowHandlers([]),
      ...runHandlers({ problems: [], any: [] }),
    );

    renderApp(`/w/${workspaceId}`);
    const checklist = await screen.findByRole(
      'region',
      { name: 'Your first thread' },
      coldStart,
    );
    expect(
      within(checklist).getByText('0 of 3 done.', { exact: false }),
    ).toBeVisible();
    expect(
      within(checklist).getByRole('link', { name: 'Create a workflow' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows?create=true`);
    expect(
      within(checklist).getByRole('link', { name: 'Publish it' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows`);
    expect(
      within(checklist).getByRole('link', { name: 'Run it' }),
    ).toBeVisible();
    expect(
      within(checklist).queryByRole('link', { name: 'Invite a teammate' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Timeline/u })).toBeNull();
  });
  it('links every first-thread step to where it is done', async () => {
    const empty = { items: [], nextCursor: null };
    mockServer.use(
      ...identityHandlers([
        ...readerCapabilities,
        'connection:read',
        'workflow:update',
        'member:read',
      ]),
      workflowHandlers([workflow({ publishedVersionId: null })]),
      ...runHandlers({ problems: [], any: [] }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/connections`,
        () => HttpResponse.json(empty),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations`,
        () => HttpResponse.json({ items: [] }),
      ),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json(empty),
      ),
    );

    renderApp(`/w/${workspaceId}`);
    const checklist = await screen.findByRole(
      'region',
      { name: 'Your first thread' },
      coldStart,
    );
    expect(
      await within(checklist).findByText('1 of 6 done.', { exact: false }),
    ).toBeVisible();
    const hrefs = Object.fromEntries(
      within(checklist)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    );
    const base = `/w/${workspaceId}`;
    expect(hrefs).toEqual({
      'Create a workflow': `${base}/workflows?create=true`,
      'Publish it': `${base}/workflows/${workflowId}`,
      'Run it': `${base}/workflows/${workflowId}`,
      'Add a connection': `${base}/connections?add=any`,
      'Set a failure alert': `${base}/settings/alerts`,
      'Invite a teammate': `${base}/team?invite=true`,
    });
  });
});
