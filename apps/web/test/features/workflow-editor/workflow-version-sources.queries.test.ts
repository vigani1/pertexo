import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { workflowVersionSourcesQueryOptions } from '@/features/workflow-editor/workflow-version-sources.queries';
import { createApiClient } from '@/lib/api/client';
import { callableVersionSource } from '../../support/workflow-version-source-fixtures';

function queryScope(fetch: typeof globalThis.fetch) {
  return {
    apiClient: createApiClient({ fetch, readCsrfToken: () => undefined }),
    userId: 'actor-a',
    workspaceId: 'workspace-a',
  };
}

describe('workflow version source query ownership', () => {
  it('separates identities, workspaces and selected workflows in cache keys', () => {
    const scope = queryScope(() =>
      Promise.resolve(Response.json({ items: [], nextCursor: null })),
    );
    const key = workflowVersionSourcesQueryOptions(scope, 'source-a').queryKey;
    expect(key).not.toEqual(
      workflowVersionSourcesQueryOptions(
        { ...scope, userId: 'actor-b' },
        'source-a',
      ).queryKey,
    );
    expect(key).not.toEqual(
      workflowVersionSourcesQueryOptions(
        { ...scope, workspaceId: 'workspace-b' },
        'source-a',
      ).queryKey,
    );
    expect(key).not.toEqual(
      workflowVersionSourcesQueryOptions(scope, 'source-b').queryKey,
    );
  });
  it('reads only the selected scoped source and rejects repeated-cursor discovery rather than returning partial items', async () => {
    const paths: string[] = [];
    const scope = queryScope((input) => {
      paths.push(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      return Promise.resolve(
        Response.json({
          items: [callableVersionSource],
          nextCursor: 'repeat',
        }),
      );
    });
    const client = new QueryClient();
    const options = workflowVersionSourcesQueryOptions(
      scope,
      'selected-source',
    );
    await expect(client.query(options)).rejects.toThrow(
      'invalid cursor sequence',
    );
    expect(paths).toHaveLength(2);
    expect(
      paths.every((path) =>
        path.startsWith(
          '/v1/workspaces/workspace-a/workflows/selected-source/versions?',
        ),
      ),
    ).toBe(true);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
  });
  it('fails honestly after forty version pages without returning an apparently complete empty list', async () => {
    let reads = 0;
    const scope = queryScope(() =>
      Promise.resolve(
        Response.json({ items: [], nextCursor: `page-${String(++reads)}` }),
      ),
    );
    const client = new QueryClient();
    await expect(
      client.query(
        workflowVersionSourcesQueryOptions(scope, 'selected-source'),
      ),
    ).rejects.toThrow('bounded page limit');
    expect(reads).toBe(40);
    client.clear();
  });
  it('passes query cancellation to the selected-source HTTP read', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const scope = queryScope(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal;
          receivedSignal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Cancelled', 'AbortError'));
            },
            { once: true },
          );
          notifyStarted?.();
        }),
    );
    const client = new QueryClient();
    const options = workflowVersionSourcesQueryOptions(
      scope,
      'selected-source',
    );
    const result = client.query(options).catch((error: unknown) => error);
    await started;
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(receivedSignal?.aborted).toBe(true);
    await result;
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
  });
});
