import { screen, waitFor, within } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureRun,
  identityHandlers,
  notFoundProblem,
} from '../../../../support/fixtures/run';

import { mockServer } from '../../../../support/mock-server';

import { renderApp } from '../../../../support/render-app';

import {
  chooseOption,
  firstRunId,
  historyReads,
  latest,
  readerCapabilities,
  workflowId,
  workflowReads,
  workspaceId,
} from './fixture';

describe('workspace runs', () => {
  it('hides cached runs when a refresh says the collection is gone', async () => {
    let unavailable = false;
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      http.get(`${apiBase}/runs`, () =>
        unavailable
          ? notFoundProblem()
          : HttpResponse.json({
              items: [fixtureRun(firstRunId, 'succeeded')],
              nextCursor: null,
            }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/runs`);
    await screen.findByRole(
      'button',
      { name: 'Copy run ID eeee…eeee' },
      coldStart,
    );
    unavailable = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', fixtureIds.user, 'workspace', workspaceId, 'runs'],
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Runs aren’t available here',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Copy run ID eeee…eeee' }),
    ).not.toBeInTheDocument();
  });
  it('explains missing run access without reading runs', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers(['workspace:read']),
      http.get(`${apiBase}/runs`, () => {
        reads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Runs aren’t available for your role' },
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(reads).toBe(0);
  });
  it('tells a failed first read apart from an empty history', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      http.get(`${apiBase}/runs`, () => HttpResponse.error()),
    );
    renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole(
        'heading',
        { name: 'Runs couldn’t be loaded' },
        coldStart,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'No runs yet' }),
    ).not.toBeInTheDocument();
  });
  it('guides an empty workspace to its workflows', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      http.get(`${apiBase}/runs`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    renderApp(`/w/${workspaceId}/runs`);
    const empty = await screen.findByRole(
      'heading',
      { name: 'No runs yet' },
      coldStart,
    );
    expect(empty).toBeVisible();
    expect(
      within(empty.parentElement ?? document.body).getByRole('link', {
        name: 'Go to workflows',
      }),
    ).toHaveAttribute('href', `/w/${workspaceId}/workflows`);
  });
  it('lists a workflow’s runs in its hub tab without a workflow filter', async () => {
    const requests: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      ...historyReads(requests),
    );
    const { router } = renderApp(
      `/w/${workspaceId}/workflows/${workflowId}/runs?workflowId=ignored`,
    );
    expect(
      await screen.findByRole('button', { name: 'Copy run ID eeee…eeee' }),
    ).toBeVisible();
    expect(screen.queryByLabelText('Workflow name')).toBeNull();
    // One start time per run: relative, with the exact time on hover.
    const run = screen.getByRole('link', { name: /^Run from /u });
    expect(run).toHaveTextContent(/ago$/u);
    expect(within(run).getByText(/ago$/u)).toHaveAttribute('title');
    expect(latest(requests).get('workflowId')).toBe(workflowId);
    await chooseOption('Status', 'Failed');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows/${workflowId}/runs`,
      );
      expect(latest(requests).get('status')).toBe('failed');
    });
  });
});
