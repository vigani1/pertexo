import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  WorkflowTagConflictError,
  type WorkflowTagDatabase,
  type WorkflowFavoriteDatabase,
} from '@pertexo/database/authoring';
import {
  AuthorizationError,
  createActorContext,
} from '../../../src/authorization/index.js';
import { WorkflowOrganizationCommandsUseCase } from '../../../src/workflow-authoring/organization/commands.js';

const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const otherTagId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: otherTagId,
  requestId: 'organization-command',
});
const tagResult = {
  tag: { id: tagId, key: 'release', revision: 2 },
  replayed: true,
};
const deleteResult = {
  tagId,
  deleted: true as const,
  detachedWorkflowCount: 50,
  replayed: true,
};
const replaceResult = {
  workflowId,
  organizationRevision: 3,
  tagIds: [otherTagId, tagId],
  replayed: true,
};
const favoriteResult = { isFavorite: false };
const base = {
  actor,
  routeWorkspaceId: workspaceId,
  workflowId,
  tagId,
  idempotencyKey: 'exact-command-key',
};

function fixture(role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner') {
  const tags = {
    listTags: vi.fn(),
    listTagAssignments: vi.fn(),
    detachTag: vi.fn(),
    close: vi.fn(),
    createTag: vi.fn().mockResolvedValue(tagResult),
    renameTag: vi.fn().mockResolvedValue(tagResult),
    deleteTag: vi.fn().mockResolvedValue(deleteResult),
    replaceTags: vi.fn().mockResolvedValue(replaceResult),
  } satisfies WorkflowTagDatabase;
  const favorites = {
    close: vi.fn(),
    setFavorite: vi.fn().mockResolvedValue(favoriteResult),
  } satisfies WorkflowFavoriteDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  const commands = new WorkflowOrganizationCommandsUseCase(
    tags,
    favorites,
    authorization,
  );
  return { tags, favorites, authorization, commands };
}

const cases = [
  {
    method: 'createTag',
    request: { key: ' Release ' },
    expected: { key: 'release' },
    result: tagResult,
  },
  {
    method: 'renameTag',
    request: { key: ' Release ', expectedTagRevision: 1 },
    expected: { tagId, key: 'release', expectedTagRevision: 1 },
    result: tagResult,
  },
  {
    method: 'deleteTag',
    request: { expectedTagRevision: 1 },
    expected: { tagId, expectedTagRevision: 1 },
    result: deleteResult,
  },
  {
    method: 'replaceTags',
    request: {
      tagIds: [tagId.toUpperCase(), otherTagId],
      expectedOrganizationRevision: 2,
    },
    expected: {
      workflowId,
      tagIds: [otherTagId, tagId],
      expectedOrganizationRevision: 2,
    },
    result: replaceResult,
  },
  {
    method: 'setFavorite',
    request: { favorite: false },
    expected: { workflowId, favorite: false },
    result: favoriteResult,
  },
] as const;

function persistence(
  f: ReturnType<typeof fixture>,
  method: (typeof cases)[number]['method'],
) {
  return method === 'setFavorite' ? f.favorites.setFavorite : f.tags[method];
}

describe('workflow organization commands', () => {
  it.each(cases)(
    'passes exact canonical scoped $method command and receipt',
    async ({ method, request, expected, result }) => {
      const f = fixture();
      const signal = new AbortController().signal;
      expect(await f.commands[method]({ ...base, request, signal })).toEqual(
        result,
      );
      // Setting a favorite is idempotent by itself and takes no key.
      expect(persistence(f, method)).toHaveBeenCalledExactlyOnceWith({
        workspaceId,
        actorId,
        signal,
        ...(method === 'setFavorite'
          ? {}
          : { idempotencyKey: base.idempotencyKey }),
        ...expected,
      });
      expect(f.authorization.findAccess).toHaveBeenCalledExactlyOnceWith({
        workspaceId,
        actorId,
        signal,
      });
    },
  );

  it.each(['owner', 'admin'] as const)(
    'admits %s vocabulary administration without broadening workspace:manage',
    async (role) => {
      const f = fixture(role);
      for (const c of cases.slice(0, 3))
        await f.commands[c.method]({ ...base, request: c.request });
      expect(f.tags.createTag).toHaveBeenCalledOnce();
      expect(f.tags.renameTag).toHaveBeenCalledOnce();
      expect(f.tags.deleteTag).toHaveBeenCalledOnce();
    },
  );

  it.each(['viewer', 'builder'] as const)(
    'denies %s vocabulary administration before persistence',
    async (role) => {
      const f = fixture(role);
      for (const c of cases.slice(0, 3)) {
        await expect(
          f.commands[c.method]({ ...base, request: c.request }),
        ).rejects.toBeInstanceOf(AuthorizationError);
        expect(persistence(f, c.method)).not.toHaveBeenCalled();
      }
    },
  );

  it('admits builder assignments and viewer personal favorites, but denies viewer assignments', async () => {
    const builder = fixture('builder');
    await builder.commands.replaceTags({ ...base, request: cases[3].request });
    const viewer = fixture('viewer');
    await viewer.commands.setFavorite({ ...base, request: cases[4].request });
    await expect(
      viewer.commands.replaceTags({ ...base, request: cases[3].request }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(viewer.tags.replaceTags).not.toHaveBeenCalled();
  });

  it.each(cases)(
    'rejects private or extra $method body properties',
    async ({ method, request }) => {
      for (const extra of [
        { actorId },
        { workspaceId },
        { generation: tagId },
        { proof: {} },
        { idempotencyKey: 'body-key' },
      ]) {
        const f = fixture();
        await expect(
          f.commands[method]({ ...base, request: { ...request, ...extra } }),
        ).rejects.toBeInstanceOf(z.ZodError);
        expect(persistence(f, method)).not.toHaveBeenCalled();
      }
    },
  );

  it.each(cases)(
    'rejects malformed $method bodies before persistence',
    async ({ method }) => {
      const f = fixture();
      await expect(
        f.commands[method]({ ...base, request: {} }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(persistence(f, method)).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    'validates $method response privacy',
    async ({ method, request, result }) => {
      const f = fixture();
      persistence(f, method).mockResolvedValueOnce({
        ...result,
        actorId,
        generation: tagId,
        proof: {},
      });
      await expect(
        f.commands[method]({ ...base, request }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expect(persistence(f, method)).toHaveBeenCalledOnce();
    },
  );

  it.each(cases)(
    'rejects malformed $method receipts',
    async ({ method, request }) => {
      const f = fixture();
      persistence(f, method).mockResolvedValueOnce({ replayed: true });
      await expect(
        f.commands[method]({ ...base, request }),
      ).rejects.toBeInstanceOf(z.ZodError);
    },
  );

  it.each(cases)(
    'does not convert or retry $method persistence errors',
    async ({ method, request }) => {
      for (const error of [
        new WorkflowTagConflictError('organization_revision'),
        new Error('unexpected'),
      ]) {
        const f = fixture();
        persistence(f, method).mockRejectedValueOnce(error);
        await expect(f.commands[method]({ ...base, request })).rejects.toBe(
          error,
        );
        expect(persistence(f, method)).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(cases)(
    'fences pre-aborted $method commands',
    async ({ method, request }) => {
      const f = fixture();
      const scope = new AbortController();
      const reason = new Error('aborted');
      scope.abort(reason);
      await expect(
        f.commands[method]({ ...base, request, signal: scope.signal }),
      ).rejects.toBe(reason);
      expect(f.authorization.findAccess).not.toHaveBeenCalled();
      expect(persistence(f, method)).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    'fences $method after authority or persistence cancellation',
    async ({ method, request, result }) => {
      for (const phase of ['authority', 'persistence'] as const) {
        const f = fixture();
        const scope = new AbortController();
        const reason = new Error('cancelled');
        if (phase === 'authority')
          f.authorization.findAccess.mockImplementationOnce(() => {
            scope.abort(reason);
            return Promise.resolve({
              actorId,
              workspaceId,
              role: 'owner',
              membershipStatus: 'active',
              workspaceStatus: 'active',
            });
          });
        else
          persistence(f, method).mockImplementationOnce(() => {
            scope.abort(reason);
            return Promise.resolve(result);
          });
        await expect(
          f.commands[method]({ ...base, request, signal: scope.signal }),
        ).rejects.toBe(reason);
        expect(persistence(f, method)).toHaveBeenCalledTimes(
          phase === 'authority' ? 0 : 1,
        );
      }
    },
  );

  it.each(cases)(
    'fences mismatched actor scope and inactive authority for $method',
    async ({ method, request }) => {
      const f = fixture();
      await expect(
        f.commands[method]({ ...base, routeWorkspaceId: otherTagId, request }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(persistence(f, method)).not.toHaveBeenCalled();
      f.authorization.findAccess.mockResolvedValueOnce({
        actorId,
        workspaceId,
        role: 'owner',
        membershipStatus: 'active',
        workspaceStatus: 'suspended',
      });
      await expect(
        f.commands[method]({ ...base, request }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(persistence(f, method)).not.toHaveBeenCalled();
    },
  );
});
