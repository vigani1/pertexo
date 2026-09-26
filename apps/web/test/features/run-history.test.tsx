import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  fixtureStatistics,
  fixtureWorkflow,
  identityHandlers,
  notFoundProblem,
  coldStart,
  statisticsHandler,
} from '../support/run-fixtures';

const { workspace: workspaceId, workflow: workflowId } = fixtureIds;
const { firstRun: firstRunId, secondRun: secondRunId } = fixtureIds;
const readerCapabilities = ['workspace:read', 'run:read', 'workflow:read'];

function workflowReads() {
  return [
    http.get(`${apiBase}/workflows`, () =>
      HttpResponse.json({ items: [fixtureWorkflow()], nextCursor: null }),
    ),
    http.get(`${apiBase}/workflows/${workflowId}`, () =>
      HttpResponse.json({ workflow: fixtureWorkflow() }),
    ),
  ];
}

/** Two pages of history, plus the statistics read behind the header. */
function historyReads(requests: URLSearchParams[] = []) {
  const history = http.get(`${apiBase}/runs`, ({ request }) => {
    const query = new URL(request.url).searchParams;
    requests.push(query);
    return HttpResponse.json(
      query.get('after') === null
        ? { items: [fixtureRun(firstRunId, 'succeeded')], nextCursor: 'next' }
        : {
            items: [
              fixtureRun(secondRunId, 'failed', { triggerType: 'webhook' }),
            ],
            nextCursor: null,
          },
    );
  });
  return [history, statisticsHandler()];
}

function latest(requests: readonly URLSearchParams[]) {
  return requests.at(-1) ?? new URLSearchParams();
}

async function chooseOption(label: string, option: string) {
  const event = userEvent.setup();
  await event.click(screen.getByRole('combobox', { name: label }));
  await event.click(await screen.findByRole('option', { name: option }));
}

describe('workspace runs', () => {
  it('paginates in StrictMode and opens a run from its row', async () => {
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      ...historyReads(),
      http.get(`${apiBase}/runs/${firstRunId}`, () =>
        HttpResponse.json({
          run: fixtureRun(firstRunId, 'succeeded'),
          nodes: [],
        }),
      ),
      http.get(
        `${apiBase}/runs/${firstRunId}/events`,
        () =>
          new HttpResponse('', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
      http.get(`${apiBase}/workflows/${workflowId}/versions`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`, { strict: true });
    expect(
      await screen.findByRole(
        'button',
        { name: 'Copy run ID eeee…eeee' },
        coldStart,
      ),
    ).toBeVisible();
    expect(screen.queryByText(firstRunId)).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(
      await screen.findByRole('button', { name: 'Copy run ID ffff…ffff' }),
    ).toBeVisible();
    const [firstLink] = screen.getAllByRole('link', {
      name: 'Customer onboarding',
    });
    if (firstLink === undefined) throw new Error('Missing run link');
    await userEvent.setup().click(firstLink);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${firstRunId}`,
      );
    });
  });

  it('shows exact live counts in the header from one statistics read', async () => {
    const requests: URLSearchParams[] = [];
    const statistics: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      statisticsHandler(
        () =>
          fixtureStatistics({
            current: { running: 101, waiting: 7, queued: 0 },
          }),
        statistics,
      ),
      ...historyReads(requests),
    );
    renderApp(`/w/${workspaceId}/runs`);
    const header = within(
      (
        await screen.findByRole(
          'heading',
          { level: 1, name: 'Runs' },
          coldStart,
        )
      ).closest('header') ?? document.body,
    );
    expect(await header.findByText('101')).toBeVisible();
    expect(header.getByText('7')).toBeVisible();
    expect(header.queryByText(/\d\+/u)).not.toBeInTheDocument();
    expect(statistics.map(String)).toEqual(['window=24h']);
    expect(requests.every((query) => query.get('status') === null)).toBe(true);
  });

  it('keeps filters in the URL and sends the chosen bounds', async () => {
    const requests: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      ...historyReads(requests),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    const event = userEvent.setup();
    await screen.findByRole('heading', { level: 1, name: 'Runs' }, coldStart);

    await chooseOption('Status', 'Succeeded');
    await waitFor(() => {
      expect(latest(requests).get('status')).toBe('succeeded');
    });
    expect(router.state.location.search).toMatchObject({ status: 'succeeded' });

    await event.type(screen.getByLabelText('Workflow name'), 'Cust{Enter}');
    await waitFor(() => {
      expect(latest(requests).get('workflowNamePrefix')).toBe('Cust');
    });

    await event.click(screen.getByRole('button', { name: 'When: Any time' }));
    // Today, twice: a range of just that day.
    const today = await screen.findByRole('button', { current: 'date' });
    await event.click(today);
    expect(screen.getByText(/Now pick the last day/u)).toBeVisible();
    await event.click(today);
    await event.click(screen.getByRole('button', { name: 'Apply range' }));
    const now = new Date();
    const localFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      .toISOString()
      .replace('.000Z', '.000000Z');
    const localBefore = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    )
      .toISOString()
      .replace('.000Z', '.000000Z');
    await waitFor(() => {
      expect(latest(requests).get('createdAtFrom')).toBe(localFrom);
      expect(latest(requests).get('createdAtBefore')).toBe(localBefore);
      expect(latest(requests).get('after')).toBeNull();
    });
    expect(router.state.location.search).toMatchObject({ range: 'custom' });

    await event.click(
      screen.getByRole('button', { name: 'Remove filter Status: Succeeded' }),
    );
    await waitFor(() => {
      expect(router.state.location.search).not.toHaveProperty('status');
    });
    router.history.back();
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({
        status: 'succeeded',
      });
    });
    await event.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
  });

  it('picks a workflow from the typeahead and narrows by trigger locally', async () => {
    const requests: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      ...historyReads(requests),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Load more' }, coldStart),
    );
    await screen.findByRole('button', { name: 'Copy run ID ffff…ffff' });

    await chooseOption('Trigger', 'Webhook');
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Copy run ID eeee…eeee' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'Copy run ID ffff…ffff' }),
    ).toBeVisible();
    expect(requests.every((query) => query.get('trigger') === null)).toBe(true);

    await event.type(screen.getByLabelText('Workflow name'), 'Custo');
    await event.click(
      await screen.findByRole('option', { name: 'Customer onboarding' }),
    );
    await waitFor(() => {
      expect(latest(requests).get('workflowId')).toBe(workflowId);
    });
    expect(router.state.location.search).toMatchObject({
      workflowId,
      trigger: 'webhook',
    });
    expect(
      await screen.findByRole('button', {
        name: 'Remove filter Workflow: Customer onboarding',
      }),
    ).toBeVisible();
  });

  it('drops unknown or malformed URL keys instead of failing the page', async () => {
    const requests: URLSearchParams[] = [];
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      ...historyReads(requests),
    );
    renderApp(
      `/w/${workspaceId}/runs?status=sideways&createdAtFrom=yesterday&workflowId=nope&unknown=1&trigger=webhook`,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Runs' }, coldStart),
    ).toBeVisible();
    await waitFor(() => {
      expect(requests.length).toBeGreaterThan(0);
    });
    const [query] = requests;
    expect(query?.get('status')).toBeNull();
    expect(query?.get('createdAtFrom')).toBeNull();
    expect(query?.get('workflowId')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Remove filter Trigger: Webhook' }),
    ).toBeVisible();
  });

  it('keeps long applied filters inspectable and keyboard removable', async () => {
    const longPrefix = 'W'.repeat(128);
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      http.get(`${apiBase}/runs`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp(
      `/w/${workspaceId}/runs?workflowNamePrefix=${longPrefix}&workflowId=${workflowId}`,
    );
    const chip = await screen.findByRole(
      'button',
      { name: `Remove filter Name: ${longPrefix}` },
      coldStart,
    );
    expect(chip).toHaveAttribute('title', `Name: ${longPrefix}`);
    chip.focus();
    await userEvent.setup().keyboard('{Enter}');
    await waitFor(() => {
      expect(router.state.location.search).not.toHaveProperty(
        'workflowNamePrefix',
      );
    });
    expect(router.state.location.search).toMatchObject({ workflowId });
    expect(
      await screen.findByRole('button', {
        name: 'Remove filter Workflow: Customer onboarding',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'No runs match these filters' }),
    ).toBeVisible();
  });

  it('keeps cached runs visible when a background refresh fails', async () => {
    let response: 'ok' | 'failed' = 'ok';
    mockServer.use(
      ...identityHandlers(readerCapabilities),
      ...workflowReads(),
      http.get(`${apiBase}/runs`, () =>
        response === 'ok'
          ? HttpResponse.json({
              items: [fixtureRun(firstRunId, 'succeeded')],
              nextCursor: null,
            })
          : HttpResponse.error(),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/runs`);
    const row = await screen.findByRole(
      'button',
      { name: 'Copy run ID eeee…eeee' },
      coldStart,
    );
    response = 'failed';
    await queryClient.refetchQueries({
      queryKey: ['identity', fixtureIds.user, 'workspace', workspaceId, 'runs'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn’t refresh. Showing results from/u,
    );
    expect(row).toBeVisible();
    response = 'ok';
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

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
