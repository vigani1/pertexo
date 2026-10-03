import {
  InfiniteQueryObserver,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSourcePicker } from '@/features/workflow-editor/components/inspector/workflow-source-picker';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
import { createApiClient } from '@/lib/api/client';
import { versionSourceWorkflow } from '../../../../support/workflow-version-source-fixtures';
import {
  userId,
  workspaceId,
} from '../../../../support/workflow-editor-fixtures';
import { workflowSourcesInfiniteQueryOptions } from '@/features/workflow-editor/workflow-version-sources.queries';

describe('bounded workflow source discovery', () => {
  it('terminates a cursor loop during actual refetch without erasing its incomplete marker', async () => {
    let reads = 0;
    const apiClient = createApiClient({
      fetch: () => {
        reads++;
        return Promise.resolve(
          Response.json({ items: [], nextCursor: 'loop' }),
        );
      },
      readCsrfToken: () => undefined,
    });
    const client = new QueryClient();
    const options = workflowSourcesInfiniteQueryOptions({
      apiClient,
      userId,
      workspaceId,
    });
    await client.infiniteQuery({
      ...options,
      initialData: {
        pages: Array.from({ length: 5 }, () => ({
          items: [],
          nextCursor: 'cached-next',
        })),
        pageParams: [null, 'cached-1', 'cached-2', 'cached-3', 'cached-4'],
      },
      staleTime: Infinity,
    });
    const observer = new InfiniteQueryObserver(client, {
      ...options,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    expect(reads).toBe(2);
    const data = await client.infiniteQuery({
      ...options,
      staleTime: Infinity,
    });
    expect(data.pages).toHaveLength(2);
    expect(data.pages.at(-1)?.nextCursor).toBe('loop');
    unsubscribe();
    client.clear();
  });
  it('bounds an actual discovery refetch to forty pages and keeps its unfinished cursor', async () => {
    let reads = 0;
    const apiClient = createApiClient({
      fetch: () =>
        Promise.resolve(
          Response.json({ items: [], nextCursor: `page-${String(++reads)}` }),
        ),
      readCsrfToken: () => undefined,
    });
    const client = new QueryClient();
    const options = workflowSourcesInfiniteQueryOptions({
      apiClient,
      userId,
      workspaceId,
    });
    await client.infiniteQuery({
      ...options,
      initialData: {
        pages: Array.from({ length: 45 }, () => ({
          items: [],
          nextCursor: 'cached-next',
        })),
        pageParams: Array.from({ length: 45 }, (_value, index) =>
          index === 0 ? null : `cached-${String(index)}`,
        ),
      },
      staleTime: Infinity,
    });
    const observer = new InfiniteQueryObserver(client, {
      ...options,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    expect(reads).toBe(40);
    const data = await client.infiniteQuery({
      ...options,
      staleTime: Infinity,
    });
    expect(data.pages).toHaveLength(40);
    expect(data.pages.at(-1)?.nextCursor).toBe('page-40');
    unsubscribe();
    client.clear();
  });
  it('does not reuse or refetch a stale ordinary workflow list with forty-five pages', async () => {
    let reads = 0;
    const apiClient = createApiClient({
      fetch: () =>
        Promise.resolve(
          Response.json({
            items: [versionSourceWorkflow(workspaceId)],
            nextCursor: `page-${String(++reads)}`,
          }),
        ),
      readCsrfToken: () => undefined,
    });
    const scope = { apiClient, userId, workspaceId };
    const client = new QueryClient();
    const ordinary = workflowsInfiniteQueryOptions(
      apiClient,
      scope.userId,
      scope.workspaceId,
    );
    const preloaded = {
      pages: Array.from({ length: 45 }, () => ({
        items: [],
        nextCursor: 'ordinary-next',
      })),
      pageParams: Array.from({ length: 45 }, (_value, index) =>
        index === 0 ? null : `ordinary-${String(index)}`,
      ),
    };
    await client.infiniteQuery({
      ...ordinary,
      initialData: preloaded,
      initialDataUpdatedAt: 1,
      staleTime: Infinity,
    });
    const view = render(
      <QueryClientProvider client={client}>
        <WorkflowSourcePicker
          scope={scope}
          selected={null}
          onSelect={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(reads).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
    });
    expect(screen.getByLabelText('Workflow source')).toBeEnabled();
    expect(reads).toBe(1);
    expect(
      client.getQueryCache().find({ queryKey: ordinary.queryKey })?.state.data,
    ).toEqual(preloaded);
    view.unmount();
    client.clear();
  });
});
