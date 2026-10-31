import { resourceFailure } from '../../src/problems/context/normalize.js';
import { problemResult } from '../support/problem.js';
import { expect, it, vi } from 'vitest';
import { WorkspaceVariablesService } from '../../src/workspace-variables/service.js';
import {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
  type WorkspaceVariablesStore,
} from '@pertexo/core/variables';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
const scope = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const noWorkflows = {
  incomplete: false,
  checkedWorkflows: 0,
  totalWorkflows: 0,
};
function fixture() {
  const store = {
    read: vi
      .fn<WorkspaceVariablesStore['read']>()
      .mockResolvedValue({ revision: 0, values: {}, descriptions: {} }),
    replace: vi
      .fn<WorkspaceVariablesStore['replace']>()
      .mockResolvedValue({ revision: 1, changed: true, replayed: false }),
    usage: vi
      .fn<WorkspaceVariablesStore['usage']>()
      .mockResolvedValue({ ...noWorkflows, items: [], next: null }),
    close: () => Promise.resolve(),
  };
  return { store, service: new WorkspaceVariablesService(store) };
}
it('refuses an invalid continuation before entering storage', async () => {
  const { service, store } = fixture();
  await expect(
    problemResult(
      Promise.resolve().then(() =>
        service.usage({ ...scope, name: 'RATE', limit: 25, after: 'e30' }),
      ),
      resourceFailure,
    ),
  ).rejects.toMatchObject({ code: 'request.invalid' });
  expect(store.usage).not.toHaveBeenCalled();
});
it.each([
  [new WorkspaceVariablesConflictError(), 'variables.changed'],
  [new WorkspaceAccessDeniedError(), 'resource.not_found'],
] as const)(
  'keeps command conflicts and lost access as safe problems',
  async (error, code) => {
    const { service, store } = fixture();
    store.replace.mockRejectedValue(error);
    await expect(
      problemResult(
        service.replace({
          ...scope,
          expectedRevision: 1,
          values: { RATE: 20 },
          idempotencyKey: 'test-key',
        }),
        resourceFailure,
      ),
    ).rejects.toMatchObject({ code });
  },
);
it('rejects a stale usage continuation with a restartable problem', async () => {
  const { service, store } = fixture();
  store.usage.mockRejectedValue(new WorkspaceVariableUsageChangedError());
  await expect(
    problemResult(
      service.usage({ ...scope, name: 'RATE', limit: 25 }),
      resourceFailure,
    ),
  ).rejects.toMatchObject({ code: 'variables.usage_changed' });
});
const cursor = {
  workflowId: scope.workspaceId,
  offset: 100,
  stamp: 'a'.repeat(64),
};

async function continuation(service: WorkspaceVariablesService) {
  const page = await service.usage({ ...scope, name: 'RATE', limit: 25 });
  if (page.nextCursor === null) throw new Error('Expected a continuation');
  return page.nextCursor;
}

it('keeps a bounded empty page continuation instead of inventing an unused result', async () => {
  const { service, store } = fixture();
  store.usage.mockResolvedValue({ ...noWorkflows, items: [], next: cursor });
  const page = await service.usage({ ...scope, name: 'RATE', limit: 25 });
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toEqual(expect.any(String));
});

it('resumes the reference check where its continuation left off', async () => {
  const { service, store } = fixture();
  store.usage.mockResolvedValueOnce({
    ...noWorkflows,
    items: [],
    next: cursor,
  });
  const after = await continuation(service);
  await service.usage({ ...scope, name: 'RATE', limit: 25, after });
  expect(store.usage).toHaveBeenLastCalledWith(
    expect.objectContaining({ after: cursor }),
  );
});

// api-11: continuations follow the shared opaque-cursor rule, which accepts
// only the one canonical encoding of a cursor.
it('refuses a continuation that is not canonically encoded', async () => {
  const { service, store } = fixture();
  store.usage.mockResolvedValueOnce({
    ...noWorkflows,
    items: [],
    next: cursor,
  });
  const after = `${await continuation(service)}=`;
  await expect(
    problemResult(
      Promise.resolve().then(() =>
        service.usage({ ...scope, name: 'RATE', limit: 25, after }),
      ),
      resourceFailure,
    ),
  ).rejects.toMatchObject({ code: 'request.invalid' });
  expect(store.usage).toHaveBeenCalledOnce();
});
