import { expect, it, vi } from 'vitest';
import { WorkspaceVariablesService } from '../../src/workspace-variables/service.js';
import {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
  type WorkspaceVariablesStore,
} from '@pertexo/database/variables';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
const scope = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
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
      .mockResolvedValue({ items: [], incomplete: false, next: null }),
    close: () => Promise.resolve(),
  };
  return { store, service: new WorkspaceVariablesService(store) };
}
it('refuses an invalid continuation before entering storage', async () => {
  const { service, store } = fixture();
  await expect(
    Promise.resolve().then(() =>
      service.usage({ ...scope, name: 'RATE', limit: 25, after: 'e30' }),
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
      service.replace({
        ...scope,
        expectedRevision: 1,
        values: { RATE: 20 },
        idempotencyKey: 'test-key',
      }),
    ).rejects.toMatchObject({ code });
  },
);
it('rejects a stale usage continuation with a restartable problem', async () => {
  const { service, store } = fixture();
  store.usage.mockRejectedValue(new WorkspaceVariableUsageChangedError());
  await expect(
    service.usage({ ...scope, name: 'RATE', limit: 25 }),
  ).rejects.toMatchObject({ code: 'variables.usage_changed' });
});
it('keeps a bounded empty page continuation instead of inventing an unused result', async () => {
  const { service, store } = fixture();
  const cursor = {
    workflowId: scope.workspaceId,
    offset: 100,
    stamp: 'a'.repeat(64),
  };
  store.usage.mockResolvedValue({ items: [], incomplete: false, next: cursor });
  const page = await service.usage({ ...scope, name: 'RATE', limit: 25 });
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBe(
    Buffer.from(JSON.stringify(cursor)).toString('base64url'),
  );
});
