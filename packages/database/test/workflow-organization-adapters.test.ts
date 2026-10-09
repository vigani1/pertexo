import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowFolderDatabase,
  WorkflowFolderConflictError,
} from '../src/authoring/workflow-folders.js';
import { createWorkflowOrganizationBatchDatabase } from '../src/authoring/workflow-organization-batches.js';
import {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
} from '../src/authoring/workflow-authoring-errors.js';
import {
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
} from '../src/authoring/workflow-organization-errors.js';
import {
  createWorkflowTagDatabase,
  WorkflowTagConflictError,
} from '../src/authoring/workflow-tags.js';
import { parseDatabaseConfig } from '../src/config.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn<(sql: string, args?: unknown[]) => Promise<unknown>>(),
  transact: vi.fn(),
  acquire: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../src/platform/database-runtime.js', () => ({
  acquireDatabasePool: mocks.acquire,
}));
vi.mock('../src/tenant-access/workspace.js', () => ({
  withTenantScopedClient: mocks.transact,
}));
const scope = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const folderId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const secondWorkflow = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const config = parseDatabaseConfig({
  connectionString: 'postgresql://pertexo_app:synthetic@127.0.0.1:5432/test',
});
const command = { ...scope, idempotencyKey: 'frozen-command' };
const folder = {
  id: folderId,
  name: 'Ops',
  parentId: null,
  revision: 1,
  depth: 1,
};
const folderResult = { folder, replayed: false };
const placement = {
  workflowId,
  folderId: null,
  organizationRevision: 2,
  replayed: false,
};
const request = {
  operation: 'move' as const,
  folderId: null,
  items: [{ workflowId, expectedOrganizationRevision: 1 }],
};
const batch = { ...command, request };
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.close.mockResolvedValue(undefined);
  mocks.acquire.mockReturnValue({ pool: {}, close: mocks.close });
  mocks.transact.mockImplementation(
    (_pool: unknown, _scope: unknown, work: (client: PoolClient) => unknown) =>
      Promise.resolve(work({ query: mocks.query } as unknown as PoolClient)),
  );
});

describe('folder adapter authority and strict projection', () => {
  it('locks current authority in workspace/actor/member order before one bounded recursive read', async () => {
    const store = createWorkflowFolderDatabase(config);
    mocks.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ items: [folder], total: 1 }] });
    const result = await store.listFolders(scope);
    expect(result).toEqual({ items: [folder] });
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(mocks.query.mock.calls[0]?.[0]).toContain('app.workspaces');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('app.users');
    expect(mocks.query.mock.calls[2]?.[0]).toContain(
      'app.workspace_memberships',
    );
    expect(mocks.query.mock.calls[3]?.[0]).toContain('limit 257');
    expect(mocks.query.mock.calls[3]?.[0]).toContain('order by id');
    expect(mocks.transact).toHaveBeenCalledTimes(1);
  });
  it('denies missing authority before hierarchy lookup', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(
      createWorkflowFolderDatabase(config).listFolders(scope),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
  it.each([
    { items: [folder], total: 2 },
    { items: [{ ...folder, depth: 5 }], total: 1 },
    { items: [{ ...folder, depth: 2 }], total: 1 },
    { items: [folder, folder], total: 2 },
    { items: [{ ...folder, privateActor: scope.actorId }], total: 1 },
    { items: Array.from({ length: 257 }, () => folder), total: 257 },
  ])('fails closed on malformed/unbounded hierarchy %#', async (row) => {
    mocks.query
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row] });
    await expect(
      createWorkflowFolderDatabase(config).listFolders(scope),
    ).rejects.toThrow();
  });
  it('canonicalizes only U+0020 display trim and binds frozen key identity', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ result: folderResult }] });
    expect(
      await createWorkflowFolderDatabase(config).createFolder({
        ...command,
        name: '  Ops  ',
        parentId: null,
      }),
    ).toEqual(folderResult);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      'folder.create',
      null,
      digest(command.idempotencyKey),
      JSON.stringify({ name: 'Ops', parentId: null }),
    ]);
  });
  it.each(['', ' '.repeat(3), '\tOps', 'Ops\n', 'Ops\u007f', 'é'.repeat(65)])(
    'rejects invalid folder name %j before checkout',
    (value) => {
      expect(() =>
        createWorkflowFolderDatabase(config).createFolder({
          ...command,
          name: value,
          parentId: null,
        }),
      ).toThrow();
      expect(mocks.transact).not.toHaveBeenCalled();
    },
  );
  it('preserves Unicode casing and exactly 128 UTF-8 bytes', async () => {
    const name = 'É'.repeat(64);
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { folder: { ...folder, name }, replayed: false } }],
    });
    await createWorkflowFolderDatabase(config).createFolder({
      ...command,
      name,
      parentId: null,
    });
    expect(mocks.query.mock.calls[0]?.[1]?.[3]).toBe(
      JSON.stringify({ name, parentId: null }),
    );
  });
  it('routes rename, hierarchy move, delete and placement through only confined helpers', async () => {
    const store = createWorkflowFolderDatabase(config);
    mocks.query
      .mockResolvedValueOnce({ rows: [{ result: folderResult }] })
      .mockResolvedValueOnce({ rows: [{ result: folderResult }] })
      .mockResolvedValueOnce({
        rows: [{ result: { folderId, deleted: true, replayed: true } }],
      })
      .mockResolvedValueOnce({ rows: [{ result: placement }] });
    await store.renameFolder({
      ...command,
      folderId,
      name: 'Ops',
      expectedFolderRevision: 1,
    });
    await store.moveFolder({
      ...command,
      folderId,
      parentId: null,
      expectedFolderRevision: 1,
    });
    await store.deleteFolder({
      ...command,
      folderId,
      expectedFolderRevision: 1,
    });
    expect(
      await store.placeWorkflow({
        ...command,
        workflowId,
        folderId: null,
        expectedOrganizationRevision: 1,
      }),
    ).toEqual(placement);
    expect(
      mocks.query.mock.calls.slice(0, 3).map((call) => call[1]?.[0]),
    ).toEqual(['folder.rename', 'folder.move', 'folder.delete']);
    expect(mocks.query.mock.calls[3]?.[0]).toContain(
      'app.execute_workflow_folder_placement',
    );
    expect(mocks.transact).toHaveBeenCalledTimes(4);
  });
  it('rejects extra SQL result fields instead of leaking internal state', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { ...folderResult, admission_xid: '1' } }],
    });
    await expect(
      createWorkflowFolderDatabase(config).createFolder({
        ...command,
        name: 'Ops',
        parentId: null,
      }),
    ).rejects.toThrow();
  });
  it('passes abort scope and borrowed runtime ownership through existing seams', async () => {
    const runtime = { close: vi.fn() },
      signal = new AbortController().signal;
    const store = createWorkflowFolderDatabase(config, { runtime });
    mocks.query.mockResolvedValueOnce({ rows: [{ result: placement }] });
    await store.placeWorkflow({
      ...command,
      workflowId,
      folderId: null,
      expectedOrganizationRevision: 1,
      signal,
    });
    expect(mocks.acquire).toHaveBeenCalledWith(config, runtime);
    expect(mocks.transact.mock.calls[0]?.[3]).toEqual({ signal });
    await store.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(runtime.close).not.toHaveBeenCalled();
  });
});

describe('shared organization tenant session', () => {
  it('preserves tag scope normalization, abort options and borrowed lease closure', async () => {
    const runtime = { close: vi.fn() };
    const signal = new AbortController().signal;
    const store = createWorkflowTagDatabase(config, { runtime });
    const tag = { id: tagId, key: 'ops', revision: 1 };
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { tag, replayed: false } }],
    });
    await expect(
      store.createTag({
        ...command,
        workspaceId: scope.workspaceId.toUpperCase(),
        key: 'Ops',
        signal,
      }),
    ).resolves.toEqual({ tag, replayed: false });
    expect(mocks.acquire).toHaveBeenCalledWith(config, runtime);
    expect(mocks.transact.mock.calls[0]?.[1]).toEqual({ ...scope, signal });
    expect(mocks.transact.mock.calls[0]?.[3]).toEqual({ signal });
    await store.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(runtime.close).not.toHaveBeenCalled();
  });
  it('validates tag scope before a transaction and retains its SQL error translation', async () => {
    const store = createWorkflowTagDatabase(config);
    await expect(
      store.createTag({ ...command, workspaceId: 'invalid', key: 'ops' }),
    ).rejects.toThrow();
    expect(mocks.transact).not.toHaveBeenCalled();
    mocks.query.mockRejectedValueOnce({ code: 'P7008' });
    await expect(store.createTag({ ...command, key: 'ops' })).rejects.toEqual(
      new WorkflowTagConflictError('organization_revision'),
    );
    expect(mocks.transact).toHaveBeenCalledTimes(1);
  });
});

describe('batch adapter full-parent transaction identity', () => {
  it('admits only the immutable full body and returns only the admitted marker', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { admitted: true } }],
    });
    expect(
      await createWorkflowOrganizationBatchDatabase(config).admitBatch(batch),
    ).toEqual({ admitted: true });
    expect(mocks.query.mock.calls[0]?.[0]).toContain(
      'app.admit_workflow_organization_batch',
    );
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      digest(command.idempotencyKey),
      JSON.stringify(request),
    ]);
    expect(mocks.transact).toHaveBeenCalledTimes(1);
  });
  it('uses a separate item transaction without auto-admission or hidden retries', async () => {
    const store = createWorkflowOrganizationBatchDatabase(config);
    mocks.query
      .mockResolvedValueOnce({ rows: [{ result: { admitted: true } }] })
      .mockResolvedValueOnce({ rows: [{ result: placement }] });
    await store.admitBatch(batch);
    expect(await store.executeBatchItem({ ...batch, workflowId })).toEqual(
      placement,
    );
    expect(mocks.transact).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[1]?.[1]).toEqual([
      digest(command.idempotencyKey),
      JSON.stringify(request),
      workflowId,
      digest(
        JSON.stringify({
          v: 1,
          p: 'organization.batch.item',
          k: digest(command.idempotencyKey),
          id: workflowId,
        }),
      ),
    ]);
  });
  it('preserves ordered selection/revisions while canonicalizing sorted tags and UUID spelling', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { admitted: true } }],
    });
    const body = {
      operation: 'replace_tags' as const,
      tagIds: [secondWorkflow.toUpperCase(), tagId.toUpperCase()],
      items: [
        { workflowId: secondWorkflow, expectedOrganizationRevision: 2 },
        {
          workflowId: workflowId.toUpperCase(),
          expectedOrganizationRevision: 7,
        },
      ],
    };
    await createWorkflowOrganizationBatchDatabase(config).admitBatch({
      ...command,
      request: body,
    });
    expect(JSON.parse(String(mocks.query.mock.calls[0]?.[1]?.[1]))).toEqual({
      ...body,
      tagIds: [tagId, secondWorkflow],
      items: [
        { workflowId: secondWorkflow, expectedOrganizationRevision: 2 },
        { workflowId, expectedOrganizationRevision: 7 },
      ],
    });
  });
  it('does not put purpose or body in the derived item-key namespace', async () => {
    const store = createWorkflowOrganizationBatchDatabase(config);
    mocks.query.mockResolvedValue({
      rows: [
        { result: { workflowId, organizationRevision: 2, replayed: true } },
      ],
    });
    await store.executeBatchItem({
      ...command,
      workflowId,
      request: { operation: 'replace_tags', tagIds: [], items: request.items },
    });
    await store.executeBatchItem({
      ...command,
      workflowId,
      request: { operation: 'tag_cleanup', tagId, items: request.items },
    });
    expect(mocks.query.mock.calls[0]?.[1]?.[3]).toBe(
      mocks.query.mock.calls[1]?.[1]?.[3],
    );
    expect(mocks.query.mock.calls[0]?.[1]?.[1]).not.toBe(
      mocks.query.mock.calls[1]?.[1]?.[1],
    );
  });
  it.each([
    { ...request, items: [] },
    { ...request, items: [request.items[0], request.items[0]] },
    { ...request, items: Array.from({ length: 51 }, () => request.items[0]) },
    { ...request, proof: true },
    { ...request, items: [{ workflowId, expectedOrganizationRevision: 0 }] },
    { operation: 'replace_tags', tagIds: [tagId, tagId], items: request.items },
  ])(
    'rejects invalid full-parent requests before checkout %#',
    async (body) => {
      await expect(
        createWorkflowOrganizationBatchDatabase(config).admitBatch({
          ...command,
          request: body as typeof request,
        }),
      ).rejects.toThrow();
      expect(mocks.transact).not.toHaveBeenCalled();
    },
  );
  it('rejects an unselected item before checkout', async () => {
    await expect(
      createWorkflowOrganizationBatchDatabase(config).executeBatchItem({
        ...batch,
        workflowId: secondWorkflow,
      }),
    ).rejects.toBeInstanceOf(WorkflowOrganizationValidationError);
    expect(mocks.transact).not.toHaveBeenCalled();
  });
  it('rejects malformed SQL admission output and preserves outcome-unknown errors without retries', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ result: { admitted: true, parentHash: 'private' } }],
    });
    const store = createWorkflowOrganizationBatchDatabase(config);
    await expect(store.admitBatch(batch)).rejects.toThrow();
    const unknown = new Error('commit outcome unknown');
    mocks.query.mockRejectedValueOnce(unknown);
    await expect(store.executeBatchItem({ ...batch, workflowId })).rejects.toBe(
      unknown,
    );
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});

describe('confined SQL error mapping', () => {
  it.each([
    ['P7011', 'name'],
    ['P7012', 'limit'],
    ['P7013', 'revision'],
    ['P7014', 'hierarchy'],
    ['P7015', 'not_empty'],
    ['P7016', 'not_visible'],
  ])('maps folder %s without details', async (code, kind) => {
    mocks.query.mockRejectedValueOnce({ code, detail: 'private' });
    await expect(
      createWorkflowFolderDatabase(config).createFolder({
        ...command,
        name: 'Ops',
        parentId: null,
      }),
    ).rejects.toMatchObject({ name: WorkflowFolderConflictError.name, kind });
  });
  it.each([
    ['P7001', WorkflowOrganizationUnavailableError],
    ['P7002', WorkflowIdempotencyConflictError],
    ['42501', WorkflowNotFoundError],
    ['22023', WorkflowOrganizationValidationError],
    ['P7008', WorkflowTagConflictError],
    ['P7009', WorkflowTagConflictError],
  ])('reuses existing error class for %s', async (code, constructor) => {
    mocks.query.mockRejectedValueOnce({ code });
    await expect(
      createWorkflowOrganizationBatchDatabase(config).admitBatch(batch),
    ).rejects.toBeInstanceOf(constructor);
  });
});
