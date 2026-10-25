import { describe, expect, it, vi } from 'vitest';

import { sendWorkflowOrganizationCommand } from '../../../../../src/features/workflows/data/organization/api';

import {
  freezeWorkflowOrganizationAttempt,
  type WorkflowOrganizationAttempt,
} from '../../../../../src/features/workflows/model/organization/requests';

import { secondWorkflowId, workflowId, workspaceId } from '../../list/fixtures';

import { client, commandScope, json, requestUrl, signal, tag } from './fixture';

describe('folder and bounded batch data layer', () => {
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
      { workflowId: ids[3], status: 'outcome_unknown' },
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
});
