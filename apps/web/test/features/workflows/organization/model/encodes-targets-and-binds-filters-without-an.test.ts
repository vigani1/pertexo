import { QueryClient } from '@tanstack/react-query';

import { describe, expect, it, vi } from 'vitest';

import {
  getWorkflowOrganizationPage,
  getWorkflowOrganizationProjection,
  getWorkflowTagAssignmentsPage,
  getWorkflowTagsPage,
  sendWorkflowOrganizationCommand,
} from '../../../../../src/features/workflows/data/organization/api';

import {
  workflowOrganizationInfiniteQueryOptions,
  workflowOrganizationKeys,
  workflowOrganizationProjectionQueryOptions,
} from '../../../../../src/features/workflows/data/organization/queries';

import { freezeWorkflowOrganizationAttempt } from '../../../../../src/features/workflows/model/organization/requests';

import { userId, workflowId, workspaceId } from '../../list/fixtures';

import { client, json, projection, requestUrl, signal } from './fixture';

describe('workflow organization transport', () => {
  it('encodes targets and binds filters without an actor selector', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(json({ items: [], nextCursor: null })),
      );
    await getWorkflowOrganizationPage(
      client(fetch),
      'workspace/path',
      {
        query: ' A&B\0 ',
        tagId: workflowId.toUpperCase(),
        favoritesOnly: 'true',
        include: 'organization',
      },
      signal(),
    );
    const url = new URL(requestUrl(fetch.mock.calls[0]?.[0]), 'http://test');
    expect(url.pathname).toContain('workspace%2Fpath');
    expect(url.searchParams.get('query')).toBe('A&B\0');
    expect(url.searchParams.get('tagId')).toBe(workflowId);
    expect(url.searchParams.get('include')).toBe('organization');
    expect(url.searchParams.has('actorId')).toBe(false);
    await getWorkflowTagsPage(client(fetch), workspaceId, {}, signal());
    await getWorkflowTagAssignmentsPage({
      api: client(fetch),
      workspaceId,
      tagId: 'tag/path',
      input: {},
      signal: signal(),
    });
    expect(requestUrl(fetch.mock.calls[2]?.[0])).toContain(
      'tag%2Fpath/workflows',
    );
  });
  it('strictly distinguishes absent include, organization, and actual combined projections', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    fetch.mockResolvedValueOnce(
      json({ items: [projection.workflow], nextCursor: null }),
    );
    await expect(
      getWorkflowOrganizationPage(api, workspaceId, {}, signal()),
    ).resolves.toMatchObject({ items: [projection.workflow] });
    fetch.mockResolvedValueOnce(
      json({ items: [projection], nextCursor: null }),
    );
    await expect(
      getWorkflowOrganizationPage(api, workspaceId, {}, signal()),
    ).rejects.toMatchObject({ kind: 'protocol' });
    fetch.mockResolvedValueOnce(
      json({ items: [projection.workflow], nextCursor: null }),
    );
    await expect(
      getWorkflowOrganizationPage(
        api,
        workspaceId,
        { include: 'organization' },
        signal(),
      ),
    ).rejects.toMatchObject({ kind: 'protocol' });
    fetch.mockResolvedValueOnce(json(projection));
    await expect(
      getWorkflowOrganizationProjection({
        api,
        workspaceId,
        workflowId,
        input: { include: 'organization' },
        signal: signal(),
      }),
    ).resolves.toEqual(projection);
    fetch.mockResolvedValueOnce(json({ ...projection, templateOrigin: null }));
    await expect(
      getWorkflowOrganizationProjection({
        api,
        workspaceId,
        workflowId,
        input: { include: 'templateOrigin,organization' },
        signal: signal(),
      }),
    ).resolves.toMatchObject({ templateOrigin: null });
    fetch.mockResolvedValueOnce(json({ ...projection, actorId: userId }));
    await expect(
      getWorkflowOrganizationProjection({
        api,
        workspaceId,
        workflowId,
        input: { include: 'organization' },
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('reuses a frozen command and returns historical receipts without installing cache', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() =>
      Promise.resolve(
        json({
          workflowId,
          organizationRevision: 2,
          tagIds: [],
          replayed: true,
        }),
      ),
    );
    fetch.mockRejectedValueOnce(new TypeError('Connection lost'));
    const attempt = freezeWorkflowOrganizationAttempt({
      kind: 'replace-tags',
      workspaceId,
      workflowId,
      idempotencyKey: 'same-command',
      body: { tagIds: [], expectedOrganizationRevision: 1 },
    });
    const api = client(fetch);
    const queries = new QueryClient();
    const key = workflowOrganizationKeys.detail(
      userId,
      workspaceId,
      workflowId,
      { include: 'organization' },
    );
    queries.setQueryData(key, projection);
    await expect(
      sendWorkflowOrganizationCommand(api, attempt, signal()),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(fetch).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 2; index++)
      await expect(
        sendWorkflowOrganizationCommand(api, attempt, signal()),
      ).resolves.toMatchObject({ replayed: true });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(
        'same-command',
      );
      expect(new Headers(init?.headers).get('x-csrf-token')).toBe(
        'csrf-token-1234567890',
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(queries.getQueryData(key)).toEqual(projection);
    queries.clear();
  });
  it('normalizes domain problems and does not automatically retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'urn:pertexo:problem:workflow.folder_not_visible',
          title: 'Workflow folder is not visible',
          status: 409,
          code: 'workflow.folder_not_visible',
          requestId: 'request-123',
        }),
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: 3 } },
    });
    await expect(
      queries.infiniteQuery(
        workflowOrganizationInfiniteQueryOptions(
          client(fetch),
          userId,
          workspaceId,
        ),
      ),
    ).rejects.toMatchObject({
      kind: 'problem',
      problem: { code: 'workflow.folder_not_visible' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    queries.clear();
  });
  it('cancels a superseded name search before dispatch and reads the final phrase', async () => {
    vi.useFakeTimers();
    const queries = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(json({ items: [], nextCursor: null })),
      );
    try {
      const first = workflowOrganizationInfiniteQueryOptions(
        client(fetch),
        userId,
        workspaceId,
        { query: 'Daily', include: 'organization' },
      );
      const pending = queries.infiniteQuery(first).catch(() => undefined);
      await queries.cancelQueries({ queryKey: first.queryKey });
      await vi.advanceTimersByTimeAsync(300);
      await pending;
      expect(fetch).not.toHaveBeenCalled();
      const final = queries.infiniteQuery(
        workflowOrganizationInfiniteQueryOptions(
          client(fetch),
          userId,
          workspaceId,
          { query: 'Daily intake ', include: 'organization' },
        ),
      );
      await vi.advanceTimersByTimeAsync(250);
      await final;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        new URL(
          requestUrl(fetch.mock.calls[0]?.[0]),
          'http://test',
        ).searchParams.get('query'),
      ).toBe('Daily intake');
    } finally {
      queries.clear();
      vi.useRealTimers();
    }
  });
  it('cancels reads and ignores a late response even when transport ignores abort', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const queries = new QueryClient();
    const options = workflowOrganizationProjectionQueryOptions({
      api: client(fetch),
      userId,
      workspaceId,
      workflowId,
      input: { include: 'organization' },
    });
    const pending = queries.query(options).catch(() => undefined);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    await queries.cancelQueries({ queryKey: options.queryKey });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish(json(projection));
    await pending;
    expect(queries.getQueryData(options.queryKey)).toBeUndefined();
    queries.clear();
  });
});
