import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  WorkflowFolderConflictError,
  type WorkflowFolderDatabase,
} from '@pertexo/database/authoring';
import {
  createActorContext,
  AuthorizationError,
} from '../../../../src/authorization/index.js';
import { WorkflowFoldersUseCase } from '../../../../src/workflow-authoring/organization/folders/use-case.js';

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
type Role = 'owner' | 'admin' | 'builder' | 'viewer';

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
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    moveFolder: vi.fn(),
    deleteFolder: vi.fn(),
    placeWorkflow: vi.fn(),
    close: vi.fn(),
  } satisfies WorkflowFolderDatabase;
  for (const operation of operations)
    store[operation.port].mockResolvedValue(operation.result);
  const useCase = new WorkflowFoldersUseCase(store, authorization);
  function invoke(operation: Operation, overrides: object = {}) {
    return useCase[operation.method]({
      ...base,
      request: operation.request,
      query: operation.request,
      ...overrides,
    });
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

      it('rejects private request/query fields before authority lookup', async () => {
        for (const injected of [
          { actorId },
          { workspaceId },
          { proof: true },
          { admission_xid: '42' },
          { idempotencyKey: 'body-key' },
          { currentRevision: 7 },
        ]) {
          const f = setup();
          const payload = { ...operation.request, ...injected };
          await expect(
            f.invoke(operation, { request: payload, query: payload }),
          ).rejects.toBeInstanceOf(z.ZodError);
          expect(f.authorization.findAccess).not.toHaveBeenCalled();
          expect(f.store[operation.port]).not.toHaveBeenCalled();
        }
      });

      it('rejects malformed input and private or incomplete persisted results', async () => {
        const invalid = setup();
        await expect(
          invalid.invoke(operation, { request: null, query: null }),
        ).rejects.toBeInstanceOf(z.ZodError);
        expect(invalid.store[operation.port]).not.toHaveBeenCalled();
        for (const result of [
          {},
          { ...operation.result, actorId, body: { name: 'private' } },
          { ...operation.result, pauseRevision: '42' },
        ]) {
          const f = setup();
          f.store[operation.port].mockResolvedValueOnce(result);
          await expect(f.invoke(operation)).rejects.toBeInstanceOf(z.ZodError);
          expect(f.store[operation.port]).toHaveBeenCalledOnce();
        }
      });

      it('fences route mismatch, missing membership and suspended workspace', async () => {
        for (const condition of ['route', 'member', 'workspace'] as const) {
          const f = setup();
          if (condition === 'member')
            f.authorization.findAccess.mockResolvedValueOnce(undefined);
          if (condition === 'workspace')
            f.authorization.findAccess.mockResolvedValueOnce({
              ...f.access,
              workspaceStatus: 'suspended',
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
