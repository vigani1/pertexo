import { HttpResponse, http } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const firstRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const secondRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const timestamp = '2026-09-15T10:00:00.000Z';
const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  role: 'viewer',
  capabilities: ['workspace:read', 'run:read'],
  createdAt: timestamp,
  updatedAt: timestamp,
};

function run(id: string, status: 'failed' | 'succeeded') {
  return {
    id,
    workspaceId,
    workflowId,
    workflowVersionId,
    status,
    triggerType: 'manual',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: '2026-09-15T10:00:02.000Z',
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

function unavailableCollection() {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:resource.not_found',
      title: 'Resource not found',
      status: 404,
      code: 'resource.not_found',
      requestId: 'request-runs-not-found',
    },
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('workspace run history', () => {
  it('paginates in StrictMode and navigates from a safe summary to run detail', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
        ({ request }) =>
          HttpResponse.json(
            new URL(request.url).searchParams.get('after') === null
              ? { items: [run(firstRunId, 'succeeded')], nextCursor: 'next' }
              : { items: [run(secondRunId, 'failed')], nextCursor: null },
          ),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        () =>
          HttpResponse.json({
            run: run(firstRunId, 'succeeded'),
            nodes: [],
          }),
      ),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${firstRunId}/events`,
        () =>
          new HttpResponse('', {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`, { strict: true });
    expect(await screen.findByText(firstRunId)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText(secondRunId)).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: `Open run ${firstRunId}` }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${firstRunId}`,
      );
    });
  });

  it('owns applied filters in the URL and sends their UTC boundaries', async () => {
    let requested = new URLSearchParams();
    mockServer.use(
      ...identityHandlers(),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs`,
        ({ request }) => {
          requested = new URL(request.url).searchParams;
          return HttpResponse.json({ items: [], nextCursor: null });
        },
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    const event = userEvent.setup();
    await screen.findByRole('heading', { name: 'Run history' });
    await event.type(screen.getByLabelText('Workflow ID'), workflowId);
    await event.selectOptions(screen.getByLabelText('Status'), 'succeeded');
    await event.type(screen.getByLabelText('Created from'), '2026-09-14');
    await event.type(screen.getByLabelText('Created before'), '2026-09-16');
    await event.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(requested.get('workflowId')).toBe(workflowId);
      expect(requested.get('status')).toBe('succeeded');
      expect(requested.get('createdAtFrom')).toBe(
        '2026-09-14T00:00:00.000000Z',
      );
      expect(requested.get('createdAtBefore')).toBe(
        '2026-09-16T00:00:00.000000Z',
      );
    });
    expect(router.state.location.search).toMatchObject({
      workflowId,
      status: 'succeeded',
    });

    await event.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(screen.getByLabelText('Workflow ID')).toHaveValue('');
    router.history.back();
    await waitFor(() => {
      expect(screen.getByLabelText('Workflow ID')).toHaveValue(workflowId);
      expect(screen.getByLabelText('Status')).toHaveValue('succeeded');
    });
  });

  it('clears unapplied values and validation even when no URL filters are applied', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/runs`);
    const event = userEvent.setup();
    await screen.findByRole('heading', { name: 'Run history' });
    await event.type(screen.getByLabelText('Workflow ID'), 'not-a-workflow');
    await event.type(screen.getByLabelText('Created from'), '2026-09-16');
    await event.type(screen.getByLabelText('Created before'), '2026-09-14');
    await event.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The before date must be later than the from date.',
    );

    await event.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('Workflow ID')).toHaveValue('');
    expect(screen.getByLabelText('Created from')).toHaveValue('');
    expect(screen.getByLabelText('Created before')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(router.state.location.search).toEqual({});
  });

  it('reports and recovers from a failed background refresh without hiding cached runs', async () => {
    let response: 'ok' | 'failed' = 'ok';
    mockServer.use(
      ...identityHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () =>
        response === 'ok'
          ? HttpResponse.json({
              items: [run(firstRunId, 'succeeded')],
              nextCursor: null,
            })
          : HttpResponse.error(),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/runs`);
    expect(await screen.findByText(firstRunId)).toBeVisible();
    response = 'failed';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'runs'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These runs may be stale',
    );
    expect(screen.getByText(firstRunId)).toBeVisible();

    response = 'ok';
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('stops showing cached run controls when a refresh returns a nondisclosing 404', async () => {
    let unavailable = false;
    mockServer.use(
      ...identityHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () =>
        unavailable
          ? unavailableCollection()
          : HttpResponse.json({
              items: [run(firstRunId, 'succeeded')],
              nextCursor: null,
            }),
      ),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/runs`);
    expect(await screen.findByText(firstRunId)).toBeVisible();
    unavailable = true;
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'runs'],
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Run history is unavailable',
      }),
    ).toBeVisible();
    expect(screen.getByText(/may not exist/iu)).toBeVisible();
    expect(screen.queryByText(firstRunId)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Apply' }),
    ).not.toBeInTheDocument();
  });

  it('does not request or advertise run history without read capability', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        capabilities: ['workspace:read'],
      }),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () => {
        reads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole('heading', {
        name: 'Run history is unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Run history' }),
    ).not.toBeInTheDocument();
    expect(reads).toBe(0);
  });

  it('keeps a failed history read distinct from an empty result', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/runs`, () =>
        HttpResponse.error(),
      ),
    );
    renderApp(`/w/${workspaceId}/runs`);
    expect(
      await screen.findByRole('heading', {
        name: 'Run history could not be loaded',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'No matching runs' }),
    ).not.toBeInTheDocument();
  });
});
