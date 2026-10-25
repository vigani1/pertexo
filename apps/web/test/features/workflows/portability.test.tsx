import { WorkflowExportDialog } from '@/features/workflows/creation/portability.public';

import { ApiError } from '@/lib/api/error';

import { workflowSummarySchema } from '@pertexo/contracts';

import { portableGraphDigest } from '@pertexo/workflow-model';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { act, render, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { Activity, StrictMode } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { renderInRouter } from '../../support/render-in-router';

import {
  api,
  discoveryHandlers,
  draftBody,
  emptyGraph,
  etag,
  graphOf,
  summary,
  userId,
  workflowId,
  workspaceId,
} from './list/fixtures';

import { client, manifest, openImport, workspace } from './portability/fixture';

describe('Portable workflow review and import', () => {
  it.each([403, 404])(
    'retains import intent after unrelated Inbox %i',
    async (status) => {
      const { event, queryClient } = openImport();
      await event.upload(
        await screen.findByLabelText('Workflow JSON file'),
        new File([JSON.stringify(manifest)], 'workflow.json', {
          type: 'application/json',
        }),
      );
      await screen.findByLabelText('Complete imported graph');
      await event.type(
        screen.getByLabelText('New workflow name'),
        'Independent draft',
      );
      await act(async () => {
        await queryClient
          .query({
            queryKey: [
              'identity',
              userId,
              'workspace',
              workspaceId,
              'inbox',
              'unread',
            ],
            queryFn: () =>
              Promise.reject(
                new ApiError({
                  kind: 'problem',
                  message: 'Inbox unavailable',
                  status,
                }),
              ),
            retry: false,
          })
          .catch(() => undefined);
      });
      await waitFor(() => {
        expect(screen.getByLabelText('New workflow name')).toHaveValue(
          'Independent draft',
        );
      });
      expect(
        screen.getByLabelText('Complete imported graph'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Access changed/u)).not.toBeInTheDocument();
    },
  );
  it('clears import intent on authentication loss observed by another feature', async () => {
    const { event, queryClient } = openImport();
    await event.type(
      await screen.findByLabelText('New workflow name'),
      'Private name',
    );
    await queryClient
      .query({
        queryKey: [
          'identity',
          userId,
          'workspace',
          workspaceId,
          'inbox',
          'unread',
        ],
        queryFn: () =>
          Promise.reject(
            new ApiError({
              kind: 'problem',
              message: 'Session expired',
              status: 401,
            }),
          ),
        retry: false,
      })
      .catch(() => undefined);
    await screen.findByText(/Access changed/u);
    expect(
      screen.queryByLabelText('New workflow name'),
    ).not.toBeInTheDocument();
  });
  it('shows full source configuration and requires the exact graph acknowledgement and draft ETag', async () => {
    const graph = graphOf([
      { id: 'source', key: 'core.manual', label: 'Private label', x: 0 },
    ]);
    const node = graph.nodes[0];
    if (node === undefined) throw new Error('Source node fixture missing');
    node.config = {
      privateLiteral: 'DO NOT SHARE',
      expression: '$lookup(private)',
    };
    const posted = vi.fn();
    mockServer.use(
      ...discoveryHandlers(),
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(draftBody(workflowId, graph), { headers: { etag } }),
      ),
      http.post(
        `${api}/workflows/${workflowId}/export`,
        async ({ request }) => {
          posted(await request.json(), request.headers.get('if-match'));
          return HttpResponse.json(manifest);
        },
      ),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:test'),
        revokeObjectURL: vi.fn(),
      }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const event = userEvent.setup();
    renderInRouter(
      <WorkflowExportDialog
        apiClient={client()}
        userId={userId}
        workspace={workspace()}
        workflow={workflowSummarySchema.parse(summary(workflowId, 'Source'))}
        source={{ kind: 'draft' }}
        onClose={vi.fn()}
      />,
    );
    const review = await screen.findByLabelText('Complete saved source graph');
    expect(review).toHaveTextContent('DO NOT SHARE');
    expect(review).toHaveTextContent('$lookup(private)');
    expect(review).toHaveTextContent('Private label');
    const download = screen.getByRole('button', {
      name: 'Download workflow JSON',
    });
    expect(download).toBeDisabled();
    await event.click(screen.getByRole('checkbox'));
    await event.click(download);
    const reviewedGraphDigest = await portableGraphDigest(graph);
    await waitFor(() => {
      expect(posted).toHaveBeenCalledWith(
        { source: { kind: 'draft' }, reviewedGraphDigest },
        etag,
      );
    });
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    click.mockRestore();
  });
  it('restarts export reads after effect reconnection and ignores the cancelled source', async () => {
    const oldGraph = graphOf([
      { id: 'old', key: 'core.manual', label: 'Old private source', x: 0 },
    ]);
    const currentGraph = graphOf([
      { id: 'current', key: 'core.manual', label: 'Current source', x: 0 },
    ]);
    const requests: AbortSignal[] = [];
    let releaseFirst: ((response: Response) => void) | undefined;
    mockServer.use(
      ...discoveryHandlers(),
      http.get(`${api}/workflows/${workflowId}/draft`, ({ request }) => {
        requests.push(request.signal);
        if (requests.length === 1)
          return new Promise<Response>((resolve) => {
            releaseFirst = resolve;
          });
        return HttpResponse.json(draftBody(workflowId, currentGraph), {
          headers: { etag },
        });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const props = {
      apiClient: client(),
      userId,
      workspace: workspace(),
      workflow: workflowSummarySchema.parse(summary(workflowId, 'Source')),
      source: { kind: 'draft' as const },
      onClose: vi.fn(),
    };
    const content = (mode: 'visible' | 'hidden') => (
      <QueryClientProvider client={queryClient}>
        <StrictMode>
          <Activity mode={mode}>
            <WorkflowExportDialog {...props} />
          </Activity>
        </StrictMode>
      </QueryClientProvider>
    );
    const view = render(content('visible'));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    view.rerender(content('hidden'));
    expect(requests[0]?.aborted).toBe(true);
    view.rerender(content('visible'));
    expect(
      await screen.findByLabelText('Complete saved source graph'),
    ).toHaveTextContent('Current source');
    await act(async () => {
      releaseFirst?.(
        HttpResponse.json(draftBody(workflowId, oldGraph), {
          headers: { etag },
        }),
      );
      await Promise.resolve();
    });
    expect(
      screen.getByLabelText('Complete saved source graph'),
    ).not.toHaveTextContent('Old private source');
    view.unmount();
    queryClient.clear();
  });
  it('disposes an export review when permission changes and requires a fresh acknowledgement', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(draftBody(workflowId, emptyGraph), {
          headers: { etag },
        }),
      ),
    );
    const queryClient = new QueryClient();
    const props = {
      apiClient: client(),
      userId,
      workspace: workspace(),
      workflow: workflowSummarySchema.parse(summary(workflowId, 'Source')),
      source: { kind: 'draft' as const },
      onClose: vi.fn(),
    };
    const content = (allowed: boolean) => (
      <QueryClientProvider client={queryClient}>
        <WorkflowExportDialog {...props} allowed={allowed} />
      </QueryClientProvider>
    );
    const view = render(content(true));
    await screen.findByLabelText('Complete saved source graph');
    await userEvent.setup().click(screen.getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: 'Download workflow JSON' }),
    ).toBeEnabled();
    view.rerender(content(false));
    expect(
      screen.getByText('Access changed. The reviewed source has been cleared.'),
    ).toBeVisible();
    expect(
      screen.queryByLabelText('Complete saved source graph'),
    ).not.toBeInTheDocument();
    view.rerender(content(true));
    await screen.findByLabelText('Complete saved source graph');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Download workflow JSON' }),
    ).toBeDisabled();
    view.unmount();
    queryClient.clear();
  });
});
