import { foldersRoutes } from '@pertexo/contracts/server';
import type { Role } from '@pertexo/policy';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  WorkflowFolderConflictError,
  type WorkflowFolderStore,
} from '@pertexo/core/authoring';
import {
  createActorContext,
  AuthorizationError,
} from '../../../../src/authorization/index.js';
import { WorkflowFoldersUseCase } from '../../../../src/workflow-authoring/organization/folders/workflow-folders.service.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const folderId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: folderId,
  requestId: 'folders',
});
const base = {
  actor,
  routeWorkspaceId: workspaceId,
  folderId,
  workflowId,
  idempotencyKey: 'folder-receipt',
};
const folder = {
  id: folderId,
  name: 'Old Display Name',
  parentId: null,
  revision: 2,
  depth: 1,
};
const receipt = { folder, replayed: true };
const operations = [
  {
    method: 'list',
    port: 'listFolders',
    request: {},
    expected: {},
    result: { items: [folder] },
  },
  {
    method: 'create',
    port: 'createFolder',
    request: { name: ' New Name ', parentId: null },
    expected: { name: 'New Name', parentId: null },
    result: receipt,
  },
  {
    method: 'rename',
    port: 'renameFolder',
    request: { name: ' New Name ', expectedFolderRevision: 1 },
    expected: { folderId, name: 'New Name', expectedFolderRevision: 1 },
    result: receipt,
  },
  {
    method: 'move',
    port: 'moveFolder',
    request: { parentId: null, expectedFolderRevision: 1 },
    expected: { folderId, parentId: null, expectedFolderRevision: 1 },
    result: receipt,
  },
  {
    method: 'delete',
    port: 'deleteFolder',
    request: { expectedFolderRevision: 1 },
    expected: { folderId, expectedFolderRevision: 1 },
    result: { folderId, deleted: true, replayed: true },
  },
  {
    method: 'place',
    port: 'placeWorkflow',
    request: { folderId: null, expectedOrganizationRevision: 7 },
    expected: { workflowId, folderId: null, expectedOrganizationRevision: 7 },
    result: {
      workflowId,
      folderId: null,
      organizationRevision: 8,
      replayed: true,
    },
  },
] as const;
type Operation = (typeof operations)[number];

function setup(role: Role = 'owner') {
  const access = {
    actorId,
    workspaceId,
    role,
    membershipStatus: 'active',
    workspaceStatus: 'active',
  };
  const authorization = { findAccess: vi.fn().mockResolvedValue(access) };
  const store = {
    sharingPrincipals: vi.fn(),
    readSharing: vi.fn(),
    replaceSharing: vi.fn(),
    reviewMove: vi.fn(),
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    moveFolder: vi.fn(),
    deleteFolder: vi.fn(),
    placeWorkflow: vi.fn(),
    close: vi.fn(),
  } satisfies WorkflowFolderStore;
  for (const operation of operations)
    store[operation.port].mockResolvedValue(operation.result);
  const useCase = new WorkflowFoldersUseCase(store, authorization);
  async function invoke(operation: Operation, overrides: object = {}) {
    const input = { ...base, request: operation.request, ...overrides };
    switch (operation.method) {
      case 'list':
        return useCase.list({
          ...input,
          query: foldersRoutes.list.query.parse(operation.request),
        });
      case 'create':
        return useCase.create({
          ...input,
          request: foldersRoutes.create.body.schema.parse(input.request),
        });
      case 'rename':
        return useCase.rename({
          ...input,
          request: foldersRoutes.rename.body.schema.parse(input.request),
        });
      case 'move':
        return useCase.move({
          ...input,
          request: foldersRoutes.move.body.schema.parse(input.request),
        });
      case 'delete':
        return useCase.delete({
          ...input,
          request: foldersRoutes.delete.body.schema.parse(input.request),
        });
      case 'place':
        return useCase.place({
          ...input,
          request: foldersRoutes.place.body.schema.parse(input.request),
        });
    }
  }
  return { access, authorization, store, invoke };
}

describe('folder use-case boundary', () => {
  for (const operation of operations) {
    describe(operation.method, () => {
      it('returns the validated historical result and forwards canonical scope exactly once', async () => {
        const f = setup();
        const signal = new AbortController().signal;
        expect(await f.invoke(operation, { signal })).toEqual(operation.result);
        expect(f.store[operation.port]).toHaveBeenCalledExactlyOnceWith({
          workspaceId,
          actorId,
          signal,
          ...(operation.method === 'list'
            ? {}
            : { idempotencyKey: base.idempotencyKey }),
          ...operation.expected,
        });
        expect(f.authorization.findAccess).toHaveBeenCalledExactlyOnceWith({
          workspaceId,
          actorId,
          signal,
        });
        expect(f.store.close).not.toHaveBeenCalled();
        for (const other of operations.filter(
          (candidate) => candidate.port !== operation.port,
        ))
          expect(f.store[other.port]).not.toHaveBeenCalled();
      });

      it.each(['owner', 'admin', 'builder', 'viewer'] as const)(
        'enforces the %s role before persistence',
        async (role) => {
          const f = setup(role);
          const allowed =
            operation.method === 'list' ||
            role === 'owner' ||
            role === 'admin' ||
            (operation.method === 'place' && role === 'builder');
          if (allowed) {
            await expect(f.invoke(operation)).resolves.toEqual(
              operation.result,
            );
            expect(f.store[operation.port]).toHaveBeenCalledOnce();
          } else {
            await expect(f.invoke(operation)).rejects.toBeInstanceOf(
              AuthorizationError,
            );
            expect(f.store[operation.port]).not.toHaveBeenCalled();
          }
        },
      );

      it('rejects incomplete results and strips private persisted metadata', async () => {
        for (const result of [
          {},
          { ...operation.result, actorId, body: { name: 'private' } },
          { ...operation.result, pauseRevision: '42' },
        ]) {
          const f = setup();
          f.store[operation.port].mockResolvedValueOnce(result);
          if (Object.keys(result).length === 0)
            await expect(f.invoke(operation)).rejects.toBeInstanceOf(
              z.ZodError,
            );
          else
            await expect(f.invoke(operation)).resolves.toEqual(
              operation.result,
            );
          expect(f.store[operation.port]).toHaveBeenCalledOnce();
        }
      });

      it('fences route mismatch, missing membership and an unavailable workspace', async () => {
        for (const condition of ['route', 'member', 'workspace'] as const) {
          const f = setup();
          if (condition === 'member')
            f.authorization.findAccess.mockResolvedValueOnce(undefined);
          if (condition === 'workspace')
            f.authorization.findAccess.mockResolvedValueOnce({
              ...f.access,
              // Only the listing reads, and a suspended workspace still reads.
              workspaceStatus:
                operation.method === 'list' ? 'pending_deletion' : 'suspended',
            });
          await expect(
            f.invoke(
              operation,
              condition === 'route' ? { routeWorkspaceId: folderId } : {},
            ),
          ).rejects.toBeInstanceOf(AuthorizationError);
          expect(f.store[operation.port]).not.toHaveBeenCalled();
        }
      });

      it('preserves cancellation before and after both asynchronous boundaries', async () => {
        for (const boundary of [
          'before',
          'authority',
          'persistence',
        ] as const) {
          const f = setup();
          const controller = new AbortController();
          const reason = new Error(`cancelled at ${boundary}`);
          if (boundary === 'before') controller.abort(reason);
          if (boundary === 'authority')
            f.authorization.findAccess.mockImplementationOnce(() => {
              controller.abort(reason);
              return Promise.resolve(f.access);
            });
          if (boundary === 'persistence')
            f.store[operation.port].mockImplementationOnce(() => {
              controller.abort(reason);
              return Promise.resolve(operation.result);
            });
          await expect(
            f.invoke(operation, { signal: controller.signal }),
          ).rejects.toBe(reason);
          expect(f.store[operation.port]).toHaveBeenCalledTimes(
            boundary === 'persistence' ? 1 : 0,
          );
          expect(f.authorization.findAccess).toHaveBeenCalledTimes(
            boundary === 'before' ? 0 : 1,
          );
        }
      });

      it('propagates persistence failures without retries or follow-up writes', async () => {
        const f = setup();
        const error = new WorkflowFolderConflictError('revision');
        f.store[operation.port].mockRejectedValueOnce(error);
        await expect(f.invoke(operation)).rejects.toBe(error);
        expect(f.store[operation.port]).toHaveBeenCalledOnce();
        for (const other of operations.filter(
          (candidate) => candidate.port !== operation.port,
        ))
          expect(f.store[other.port]).not.toHaveBeenCalled();
      });
    });
  }

  it('forwards a concrete placement target without replacing shared organization CAS', async () => {
    const f = setup('builder');
    const place = operations[5];
    const request = {
      folderId: folderId.toUpperCase(),
      expectedOrganizationRevision: 7,
    };
    await f.invoke(place, { request });
    expect(f.store.placeWorkflow).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      actorId,
      workflowId,
      folderId,
      expectedOrganizationRevision: 7,
      idempotencyKey: base.idempotencyKey,
    });
    expect(f.store.moveFolder).not.toHaveBeenCalled();
  });

  it('rejects malformed nested folder metadata rather than constructing new replay metadata', async () => {
    for (const method of [operations[1], operations[2], operations[3]]) {
      const f = setup();
      f.store[method.port].mockResolvedValueOnce({
        folder: { ...folder, depth: 2, parentId: null },
        replayed: true,
      });
      await expect(f.invoke(method)).rejects.toBeInstanceOf(z.ZodError);
      expect(f.store[method.port]).toHaveBeenCalledOnce();
    }
  });
});
