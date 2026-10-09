import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createApiClient } from '../../../src/lib/api/client';
import {
  freezeWorkflowOrganizationAttempt,
  normalizeWorkflowOrganizationListQuery,
  type WorkflowOrganizationAttempt,
} from '../../../src/features/workflows/model/workflow-organization';
import {
  getWorkflowOrganizationPage,
  getWorkflowOrganizationProjection,
  getWorkflowTagsPage,
  getWorkflowTagAssignmentsPage,
  sendWorkflowOrganizationCommand,
  getWorkflowFolders,
} from '../../../src/features/workflows/organization.api';
import {
  workflowOrganizationKeys,
  workflowOrganizationProjectionQueryOptions,
  workflowOrganizationInfiniteQueryOptions,
  workflowFoldersQueryOptions,
} from '../../../src/features/workflows/organization.queries';
import {
  summary,
  userId,
  workspaceId,
  workflowId,
  secondWorkflowId,
} from './workflow-list.fixtures';

const signal = () => new AbortController().signal;
const commandScope = { workspaceId, idempotencyKey: 'individual-command' };
const folder = {
  id: secondWorkflowId,
  name: 'Ops',
  parentId: null,
  revision: 2,
  depth: 1,
};
const tag = { id: secondWorkflowId, key: 'ops', revision: 1 };
const organization = {
  tags: [tag],
  organizationRevision: 1,
  folderId: null,
  isFavorite: true,
};
const projection = {
  workflow: summary(workflowId, 'Operations'),
  organization,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
function client(fetch: typeof globalThis.fetch) {
  return createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-1234567890',
  });
}
function requestUrl(input: RequestInfo | URL | undefined) {
  if (input === undefined) throw new Error('Missing request');
  return input instanceof Request ? input.url : input.toString();
}

describe('workflow organization model and keys', () => {
  it('normalizes only literal spaces, preserves NUL, and enforces UTF8 limits', () => {
    expect(
      normalizeWorkflowOrganizationListQuery({ query: '  ops  ' }).query,
    ).toBe('ops');
    expect(
      normalizeWorkflowOrganizationListQuery({ query: '  ' }),
    ).not.toHaveProperty('query');
    expect(
      normalizeWorkflowOrganizationListQuery({ query: '\tOps\t' }).query,
    ).toBe('\tOps\t');
    expect(normalizeWorkflowOrganizationListQuery({ query: '\0' }).query).toBe(
      '\0',
    );
    expect(() =>
      normalizeWorkflowOrganizationListQuery({ query: 'é'.repeat(65) }),
    ).toThrow();
    expect(() =>
      normalizeWorkflowOrganizationListQuery({ actorId: userId }),
    ).toThrow();
  });

  it('binds every normalized variable and keeps private metadata actor-scoped', () => {
    const key = workflowOrganizationKeys.list(userId, workspaceId);
    expect(key).toEqual(
      workflowOrganizationKeys.list(userId, workspaceId, {
        limit: 25,
        view: 'all',
        order: 'updated_desc',
        query: ' ',
      }),
    );
    for (const input of [
      { limit: 1 },
      { view: 'archived' },
      { order: 'created_asc' },
      { query: 'ops' },
      { tagId: workflowId },
      { favoritesOnly: 'true' },
      { include: 'organization' },
      { after: 'cursor' },
    ]) {
      expect(
        workflowOrganizationKeys.list(userId, workspaceId, input),
      ).not.toEqual(key);
    }
    expect(
      workflowOrganizationKeys.list('another-actor', workspaceId),
    ).not.toEqual(key);
    expect(
      workflowOrganizationKeys.list(userId, 'another-workspace'),
    ).not.toEqual(key);
    expect(key).toContain('workflow-organization');
  });

  it('clones and freezes exact command bodies, revisions, targets and keys', () => {
    const body = {
      tagIds: [secondWorkflowId, workflowId],
      expectedOrganizationRevision: 3,
    };
    const attempt = freezeWorkflowOrganizationAttempt({
      kind: 'replace-tags',
      workspaceId,
      workflowId,
      idempotencyKey: 'accepted-command',
      body,
    });
    body.tagIds.pop();
    body.expectedOrganizationRevision = 4;
    expect(attempt.body).toEqual({
      tagIds: [workflowId, secondWorkflowId],
      expectedOrganizationRevision: 3,
    });
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.body)).toBe(true);
    if (attempt.kind === 'replace-tags')
      expect(Object.isFrozen(attempt.body.tagIds)).toBe(true);
    expect(
      freezeWorkflowOrganizationAttempt({
        kind: 'create-tag',
        workspaceId,
        idempotencyKey: 'tag',
        body: { key: ' OPS ' },
      }).body,
    ).toEqual({ key: 'ops' });
  });
});

describe('folder and bounded batch data layer', () => {
  it('binds root, UUID and absent folder filters separately', async () => {
    const key = workflowOrganizationKeys.list(userId, workspaceId);
    const root = workflowOrganizationKeys.list(userId, workspaceId, {
      folderId: 'root',
    });
    const selected = workflowOrganizationKeys.list(userId, workspaceId, {
      folderId: secondWorkflowId.toUpperCase(),
    });
    expect(root).not.toEqual(key);
    expect(selected).not.toEqual(root);
    expect(selected).toEqual(
      workflowOrganizationKeys.list(userId, workspaceId, {
        folderId: secondWorkflowId,
      }),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json({ items: [], nextCursor: null }));
    await getWorkflowOrganizationPage(
      client(fetch),
      workspaceId,
      { folderId: 'root' },
      signal(),
    );
    expect(
      new URL(
        requestUrl(fetch.mock.calls[0]?.[0]),
        'http://test',
      ).searchParams.get('folderId'),
    ).toBe('root');
  });

  it('reads a strict bounded folder vocabulary with actor/workspace isolation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    fetch.mockResolvedValueOnce(json({ items: [folder] }));
    const options = workflowFoldersQueryOptions(api, userId, workspaceId);
    expect(options.retry).toBe(false);
    expect(options.queryKey).not.toEqual(
      workflowOrganizationKeys.folders('other-actor', workspaceId),
    );
    expect(options.queryKey).not.toEqual(
      workflowOrganizationKeys.folders(userId, 'other-workspace'),
    );
    const queries = new QueryClient();
    await expect(queries.query(options)).resolves.toEqual({ items: [folder] });
    expect(requestUrl(fetch.mock.calls[0]?.[0])).toBe(
      `/v1/workspaces/${workspaceId}/workflow-folders`,
    );
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    for (const invalid of [
      { items: [folder], nextCursor: null },
      { items: [folder, folder] },
      { items: Array.from({ length: 257 }, () => folder) },
      { items: [{ ...folder, depth: 2 }] },
    ]) {
      fetch.mockResolvedValueOnce(json(invalid));
      await expect(
        getWorkflowFolders(api, workspaceId, {}, signal()),
      ).rejects.toMatchObject({ kind: 'protocol' });
    }
    expect(() =>
      getWorkflowFolders(api, workspaceId, { selectAll: true }, signal()),
    ).toThrow();
    queries.clear();
  });

  it.each([
    {
      command: {
        ...commandScope,
        kind: 'create-folder',
        body: { name: ' Ops ', parentId: null },
      },
      suffix: '/workflow-folders',
      receipt: { folder, replayed: false },
    },
    {
      command: {
        ...commandScope,
        kind: 'rename-folder',
        folderId: 'folder/path',
        body: { name: ' Ops ', expectedFolderRevision: 1 },
      },
      suffix: '/workflow-folders/folder%2Fpath/rename',
      receipt: { folder, replayed: false },
    },
    {
      command: {
        ...commandScope,
        kind: 'move-folder',
        folderId: secondWorkflowId,
        body: { parentId: null, expectedFolderRevision: 1 },
      },
      suffix: `/workflow-folders/${secondWorkflowId}/move`,
      receipt: { folder, replayed: true },
    },
    {
      command: {
        ...commandScope,
        kind: 'delete-folder',
        folderId: secondWorkflowId,
        body: { expectedFolderRevision: 2 },
      },
      suffix: `/workflow-folders/${secondWorkflowId}/delete`,
      receipt: { folderId: secondWorkflowId, deleted: true, replayed: false },
    },
    {
      command: {
        ...commandScope,
        kind: 'place-folder',
        workflowId,
        body: { folderId: null, expectedOrganizationRevision: 3 },
      },
      suffix: `/workflows/${workflowId}/folder`,
      receipt: {
        workflowId,
        folderId: null,
        organizationRevision: 4,
        replayed: false,
      },
    },
  ] satisfies {
    command: WorkflowOrganizationAttempt;
    suffix: string;
    receipt: unknown;
  }[])(
    'sends $command.kind with its frozen precondition and strict receipt',
    async ({ command, suffix, receipt }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json(receipt));
      const attempt = freezeWorkflowOrganizationAttempt(command);
      await expect(
        sendWorkflowOrganizationCommand(client(fetch), attempt, signal()),
      ).resolves.toEqual(receipt);
      expect(requestUrl(fetch.mock.calls[0]?.[0])).toBe(
        `/v1/workspaces/${workspaceId}${suffix}`,
      );
      const body = fetch.mock.calls[0]?.[1]?.body;
      if (typeof body !== 'string') throw new Error('Expected JSON');
      expect(JSON.parse(body)).toEqual(attempt.body);
      if ('name' in attempt.body) expect(attempt.body.name).toBe('Ops');
      expect(
        new Headers(fetch.mock.calls[0]?.[1]?.headers).get('idempotency-key'),
      ).toBe(commandScope.idempotencyKey);
      expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('retains folder display casing and rejects control characters and oversized UTF8', () => {
    for (const name of ['\tOps', 'Ops\0', 'Ops\u007f', 'é'.repeat(65), ' ']) {
      expect(() =>
        freezeWorkflowOrganizationAttempt({
          ...commandScope,
          kind: 'create-folder',
          body: { name, parentId: null },
        }),
      ).toThrow();
    }
    expect(
      freezeWorkflowOrganizationAttempt({
        ...commandScope,
        kind: 'create-folder',
        body: { name: ' Équipe ', parentId: secondWorkflowId.toUpperCase() },
      }).body,
    ).toEqual({ name: 'Équipe', parentId: secondWorkflowId });
  });

  it.each(['move', 'replace_tags', 'tag_cleanup'] as const)(
    'freezes and retries the full ordered %s selection after uncertain transport',
    async (operation) => {
      const items = [
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 8 },
        { workflowId, expectedOrganizationRevision: 3 },
      ];
      const attempt =
        operation === 'tag_cleanup'
          ? freezeWorkflowOrganizationAttempt({
              ...commandScope,
              kind: 'tag-cleanup',
              body: { tagId: secondWorkflowId, items },
            })
          : freezeWorkflowOrganizationAttempt({
              ...commandScope,
              kind: 'bulk',
              body:
                operation === 'move'
                  ? { operation, folderId: null, items }
                  : {
                      operation,
                      tagIds: [secondWorkflowId, workflowId],
                      items,
                    },
            });
      items.reverse();
      const firstItem = items[0];
      if (firstItem === undefined) throw new Error('Expected selected item');
      firstItem.expectedOrganizationRevision = 999;
      if (!('items' in attempt.body)) throw new Error('Expected batch');
      expect(attempt.body.items).toEqual([
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 8 },
        { workflowId, expectedOrganizationRevision: 3 },
      ]);
      expect(Object.isFrozen(attempt.body.items)).toBe(true);
      expect(attempt.body.items.every(Object.isFrozen)).toBe(true);
      if ('tagIds' in attempt.body)
        expect(Object.isFrozen(attempt.body.tagIds)).toBe(true);
      const receipt = {
        items: [
          {
            workflowId: secondWorkflowId,
            status: operation === 'tag_cleanup' ? 'detached' : 'updated',
            organizationRevision: 9,
            replayed: true,
          },
          { workflowId, status: 'outcome_unknown' },
        ],
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new TypeError('Unknown outcome'))
        .mockResolvedValueOnce(json(receipt));
      const api = client(fetch);
      await expect(
        sendWorkflowOrganizationCommand(api, attempt, signal()),
      ).rejects.toMatchObject({ kind: 'network' });
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(
        sendWorkflowOrganizationCommand(api, attempt, signal()),
      ).resolves.toEqual(receipt);
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(
        fetch.mock.calls[1]?.[1]?.body,
      );
      expect(
        new Headers(fetch.mock.calls[1]?.[1]?.headers).get('idempotency-key'),
      ).toBe(commandScope.idempotencyKey);
      expect(requestUrl(fetch.mock.calls[1]?.[0])).toContain(
        operation === 'tag_cleanup'
          ? '/workflow-tags/cleanup/detach'
          : '/workflows/organization/bulk',
      );
    },
  );

  it('rejects unbounded, duplicate, select-all and mixed bulk selections before transport', () => {
    const item = { workflowId, expectedOrganizationRevision: 1 };
    const invalidBodies = [
      { operation: 'move' as const, folderId: null, items: [] },
      { operation: 'move' as const, folderId: null, items: [item, item] },
      {
        operation: 'move' as const,
        folderId: null,
        items: Array.from({ length: 51 }, () => item),
      },
      {
        operation: 'move' as const,
        folderId: null,
        items: [item],
        selectAll: true,
      },
      { operation: 'move' as const, folderId: null, items: [item], tagIds: [] },
    ];
    for (const body of invalidBodies)
      expect(() =>
        freezeWorkflowOrganizationAttempt({
          ...commandScope,
          kind: 'bulk',
          body,
        }),
      ).toThrow();
  });

  it('decodes ordered partial statuses and rejects malformed, reordered or incomplete outcomes', async () => {
    const ids = Array.from(
      { length: 7 },
      (_, index) =>
        `${(index + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const attempt = freezeWorkflowOrganizationAttempt({
      ...commandScope,
      kind: 'bulk',
      body: {
        operation: 'move',
        folderId: null,
        items: ids.map((id) => ({
          workflowId: id,
          expectedOrganizationRevision: 1,
        })),
      },
    });
    const outcomes = [
      {
        workflowId: ids[0],
        status: 'updated',
        organizationRevision: 2,
        replayed: true,
      },
      { workflowId: ids[1], status: 'not_visible' },
      {
        workflowId: ids[2],
        status: 'conflict',
        code: 'workflow.folder_not_visible',
      },
      {
        workflowId: ids[3],
        status: 'unavailable',
        code: 'workflow.organization_unavailable',
      },
      { workflowId: ids[4], status: 'outcome_unknown' },
      { workflowId: ids[5], status: 'forbidden' },
      { workflowId: ids[6], status: 'not_processed' },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = client(fetch);
    fetch.mockResolvedValueOnce(json({ items: outcomes }));
    await expect(
      sendWorkflowOrganizationCommand(api, attempt, signal()),
    ).resolves.toEqual({ items: outcomes });
    for (const invalid of [
      [...outcomes].reverse(),
      outcomes.slice(1),
      outcomes.map((item, index) =>
        index === 1 ? { ...item, organizationRevision: 42 } : item,
      ),
      outcomes.map((item, index) =>
        index === 2 ? { ...item, code: 'workflow.tag_key_conflict' } : item,
      ),
      outcomes.map((item, index) =>
        index === 6 ? { ...item, status: 'not_visible' } : item,
      ),
    ]) {
      fetch.mockResolvedValueOnce(json({ items: invalid }));
      await expect(
        sendWorkflowOrganizationCommand(api, attempt, signal()),
      ).rejects.toMatchObject({ kind: 'protocol' });
    }
  });
});

describe('workflow organization transport', () => {
  it.each([
    {
      command: { ...commandScope, kind: 'create-tag', body: { key: 'OPS' } },
      suffix: '/workflow-tags',
      receipt: { tag, replayed: false },
    },
    {
      command: {
        ...commandScope,
        kind: 'rename-tag',
        tagId: secondWorkflowId,
        body: { key: 'OPS', expectedTagRevision: 2 },
      },
      suffix: `/workflow-tags/${secondWorkflowId}/rename`,
      receipt: { tag, replayed: false },
    },
    {
      command: {
        ...commandScope,
        kind: 'delete-tag',
        tagId: secondWorkflowId,
        body: { expectedTagRevision: 2 },
      },
      suffix: `/workflow-tags/${secondWorkflowId}/delete`,
      receipt: {
        tagId: secondWorkflowId,
        deleted: true,
        detachedWorkflowCount: 0,
        replayed: false,
      },
    },
    {
      command: {
        ...commandScope,
        kind: 'replace-tags',
        workflowId,
        body: { tagIds: [secondWorkflowId], expectedOrganizationRevision: 2 },
      },
      suffix: `/workflows/${workflowId}/tags`,
      receipt: {
        workflowId,
        organizationRevision: 3,
        tagIds: [secondWorkflowId],
        replayed: false,
      },
    },
  ] satisfies {
    command: WorkflowOrganizationAttempt;
    suffix: string;
    receipt: unknown;
  }[])(
    'sends the $command.kind command to its individual endpoint',
    async ({ command, suffix, receipt }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json(receipt));
      const attempt = freezeWorkflowOrganizationAttempt({
        ...command,
        workspaceId,
        idempotencyKey: 'individual-command',
      });
      await expect(
        sendWorkflowOrganizationCommand(client(fetch), attempt, signal()),
      ).resolves.toEqual(receipt);
      expect(requestUrl(fetch.mock.calls[0]?.[0])).toBe(
        `/v1/workspaces/${workspaceId}${suffix}`,
      );
      expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST');
      const body = fetch.mock.calls[0]?.[1]?.body;
      if (typeof body !== 'string') throw new Error('Expected JSON body');
      expect(JSON.parse(body)).toEqual(attempt.body);
    },
  );

  it('forwards cancellation for writes without issuing an automatic retry', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const attempt = freezeWorkflowOrganizationAttempt({
      kind: 'replace-tags',
      workspaceId,
      workflowId,
      idempotencyKey: 'canceled-command',
      body: { tagIds: [], expectedOrganizationRevision: 1 },
    });
    const pending = sendWorkflowOrganizationCommand(
      client(fetch),
      attempt,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'canceled' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

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
    await getWorkflowTagAssignmentsPage(
      client(fetch),
      workspaceId,
      'tag/path',
      {},
      signal(),
    );
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
      getWorkflowOrganizationProjection(
        api,
        workspaceId,
        workflowId,
        { include: 'organization' },
        signal(),
      ),
    ).resolves.toEqual(projection);
    fetch.mockResolvedValueOnce(json({ ...projection, templateOrigin: null }));
    await expect(
      getWorkflowOrganizationProjection(
        api,
        workspaceId,
        workflowId,
        { include: 'templateOrigin,organization' },
        signal(),
      ),
    ).resolves.toMatchObject({ templateOrigin: null });
    fetch.mockResolvedValueOnce(json({ ...projection, actorId: userId }));
    await expect(
      getWorkflowOrganizationProjection(
        api,
        workspaceId,
        workflowId,
        { include: 'organization' },
        signal(),
      ),
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
          type: 'urn:pertexo:problem:workflow.organization_unavailable',
          title: 'Workflow organization unavailable',
          status: 503,
          code: 'workflow.organization_unavailable',
          requestId: 'request-123',
        }),
        {
          status: 503,
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
      problem: { code: 'workflow.organization_unavailable' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    queries.clear();
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
    const options = workflowOrganizationProjectionQueryOptions(
      client(fetch),
      userId,
      workspaceId,
      workflowId,
      { include: 'organization' },
    );
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
