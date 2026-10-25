import { QueryClient } from '@tanstack/react-query';

import { describe, expect, it, vi } from 'vitest';

import {
  getWorkflowFolders,
  getWorkflowOrganizationPage,
  sendWorkflowOrganizationCommand,
} from '../../../../src/features/workflows/data/organization/api';

import {
  workflowFoldersQueryOptions,
  workflowOrganizationKeys,
} from '../../../../src/features/workflows/data/organization/queries';

import {
  freezeWorkflowOrganizationAttempt,
  normalizeWorkflowOrganizationListQuery,
  type WorkflowOrganizationAttempt,
} from '../../../../src/features/workflows/model/organization/requests';

import {
  secondWorkflowId,
  userId,
  workflowId,
  workspaceId,
} from '../list/fixtures';

import {
  client,
  commandScope,
  folder,
  json,
  requestUrl,
  signal,
} from './model/fixture';

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
});
