import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  workflowCallableTargetsPageQueryOptions,
  workflowCallableTargetVersionQueryOptions,
} from '@/features/workflow-editor/workflow-callable-targets.queries';
import { workflowVersionSourcesQueryOptions } from '@/features/workflow-editor/workflow-version-sources.queries';
import { workflowKeys } from '@/features/workflows/queries.public';
import { createApiClient } from '@/lib/api/client';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
// Controlled transport fixture only; it does not establish native availability.
const body = {
  projection: 'callableTarget',
  workspaceId,
  permissions: { canEditDraft: false, canUseInPublication: false },
  items: [
    {
      id: versionId,
      workflowId,
      versionNumber: 1,
      publishedAt: '2026-10-04T10:00:00.000Z',
      callableTarget: {
        pin: null,
        contract: null,
        eligibility: {
          status: 'unavailable',
          reason: 'native_authoring_unavailable',
        },
      },
    },
  ],
  nextCursor: null,
};

function scope(
  fetch: typeof globalThis.fetch = () => Promise.resolve(Response.json(body)),
) {
  return {
    apiClient: createApiClient({ fetch, readCsrfToken: () => undefined }),
    userId: 'actor-a',
    workspaceId,
  };
}

describe('callable-target projection query ownership', () => {
  it('isolates actor, workspace, workflow, projection, page inputs and exact selected version', () => {
    const selected = scope();
    const page = workflowCallableTargetsPageQueryOptions(
      selected,
      workflowId,
    ).queryKey;
    expect(page).toContain('callableTarget');
    const variants = [
      workflowCallableTargetsPageQueryOptions(
        { ...selected, userId: 'actor-b' },
        workflowId,
      ).queryKey,
      workflowCallableTargetsPageQueryOptions(
        { ...selected, workspaceId: 'other-workspace' },
        workflowId,
      ).queryKey,
      workflowCallableTargetsPageQueryOptions(selected, 'other-workflow')
        .queryKey,
      workflowCallableTargetsPageQueryOptions(selected, workflowId, {
        limit: 2,
      }).queryKey,
      workflowCallableTargetsPageQueryOptions(selected, workflowId, {
        after: 'cursor',
      }).queryKey,
      workflowVersionSourcesQueryOptions(selected, workflowId).queryKey,
      workflowKeys.detail(selected.userId, selected.workspaceId, workflowId),
      workflowCallableTargetVersionQueryOptions(selected, workflowId, versionId)
        .queryKey,
    ];
    for (const key of variants) expect(page).not.toEqual(key);
    expect(page).toEqual(
      workflowCallableTargetsPageQueryOptions(selected, workflowId, {
        limit: 1,
      }).queryKey,
    );
    const exact = workflowCallableTargetVersionQueryOptions(
      selected,
      workflowId,
      versionId,
    ).queryKey;
    expect(exact).not.toEqual(
      workflowCallableTargetVersionQueryOptions(
        selected,
        workflowId,
        workflowId,
      ).queryKey,
    );
    expect(exact).not.toEqual(
      workflowCallableTargetVersionQueryOptions(
        { ...selected, userId: 'actor-b' },
        workflowId,
        versionId,
      ).queryKey,
    );
    expect(exact).not.toEqual(
      workflowCallableTargetVersionQueryOptions(
        { ...selected, workspaceId: workflowId },
        workflowId,
        versionId,
      ).queryKey,
    );
    expect(exact).not.toEqual(
      workflowCallableTargetVersionQueryOptions(
        selected,
        workspaceId,
        versionId,
      ).queryKey,
    );
  });

  it('reads just the explicitly requested page and never follows its cursor automatically', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...body, nextCursor: 'next-page' }));
    const selected = scope(fetch);
    const client = new QueryClient();
    const options = workflowCallableTargetsPageQueryOptions(
      selected,
      workflowId,
    );
    await expect(client.query(options)).resolves.toMatchObject({
      nextCursor: 'next-page',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toContain(
      'include=callableTarget&limit=1',
    );
    expect(options.staleTime).toBe(0);
    expect(options.retry).toBe(false);
    client.clear();
  });

  it('does not seed projection from legacy sources or return a cached exact observation as fresh', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(Response.json(body)));
    const selected = scope(fetch);
    const client = new QueryClient();
    client.setQueryData(
      workflowVersionSourcesQueryOptions(selected, workflowId).queryKey,
      { items: [], nextCursor: null },
    );
    const options = workflowCallableTargetVersionQueryOptions(
      selected,
      workflowId,
      versionId,
    );
    await client.query(options);
    await client.query(options);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toContain(
      `include=callableTarget&versionId=${versionId}`,
    );
    expect(options.retry).toBe(false);
    client.clear();
  });

  it('passes exact-query cancellation through HTTP and never caches its late response', async () => {
    let signal: AbortSignal | null | undefined;
    let notifyStarted: (() => void) | undefined;
    let deliver: ((value: Response) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const selected = scope(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          signal = init?.signal;
          deliver = resolve;
          notifyStarted?.();
        }),
    );
    const client = new QueryClient();
    const options = workflowCallableTargetVersionQueryOptions(
      selected,
      workflowId,
      versionId,
    );
    const result = client.query(options).catch((error: unknown) => error);
    await started;
    await client.cancelQueries({ queryKey: options.queryKey });
    expect(signal?.aborted).toBe(true);
    deliver?.(Response.json(body));
    await result;
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
  });

  it('does not retry or cache an invalid projection as an empty successful page', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    const selected = scope(fetch);
    const client = new QueryClient();
    const options = workflowCallableTargetsPageQueryOptions(
      selected,
      workflowId,
    );
    await expect(client.query(options)).rejects.toMatchObject({
      kind: 'protocol',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
  });
});
