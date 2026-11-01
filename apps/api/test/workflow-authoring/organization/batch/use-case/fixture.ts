import { vi } from 'vitest';

import type {
  WorkflowOrganizationBatchDatabase,
  WorkflowOrganizationBatchInput,
  WorkflowOrganizationBatchItemResult,
} from '@pertexo/core/authoring';

import {
  createActorContext,
  type WorkspaceAccess,
  type WorkspaceAuthorizationPort,
} from '../../../../../src/authorization/index.js';
import { WorkflowOrganizationBatchesUseCase } from '../../../../../src/workflow-authoring/organization/batch/use-case.js';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const firstId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const folderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const tagId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: folderId,
  requestId: 'organization-batch',
});

export const base = {
  actor,
  routeWorkspaceId: workspaceId,
  idempotencyKey: 'frozen-parent-key',
};

export const items = [
  { workflowId: firstId, expectedOrganizationRevision: 7 },
  { workflowId: secondId, expectedOrganizationRevision: 2 },
];

export const move = { operation: 'move' as const, folderId, items };

export const cleanup = { tagId, items };

export const access = (
  role: WorkspaceAccess['role'] = 'owner',
): WorkspaceAccess => ({
  actorId,
  workspaceId,
  role,
  membershipStatus: 'active',
  workspaceStatus: 'active',
});

export const updated = (
  workflowId: string,
  organizationRevision = 8,
  replayed = false,
) => ({
  workflowId,
  status: 'updated' as const,
  organizationRevision,
  replayed,
});

export function result(
  input: WorkflowOrganizationBatchInput & Readonly<{ workflowId: string }>,
): WorkflowOrganizationBatchItemResult {
  return {
    workflowId: input.workflowId,
    organizationRevision: 8,
    replayed: false,
    ...(input.request.operation === 'move'
      ? { folderId: input.request.folderId }
      : {}),
  };
}

export function fixture(role: WorkspaceAccess['role'] = 'owner') {
  const batches = {
    admitBatch: vi
      .fn<WorkflowOrganizationBatchDatabase['admitBatch']>()
      .mockResolvedValue({ admitted: true }),
    executeBatchItem: vi
      .fn<WorkflowOrganizationBatchDatabase['executeBatchItem']>()
      .mockImplementation((input) => Promise.resolve(result(input))),
    close: vi.fn<WorkflowOrganizationBatchDatabase['close']>(),
  } satisfies WorkflowOrganizationBatchDatabase;
  const authorization = {
    findAccess: vi
      .fn<WorkspaceAuthorizationPort['findAccess']>()
      .mockResolvedValue(access(role)),
  };
  return {
    batches,
    authorization,
    useCase: new WorkflowOrganizationBatchesUseCase(batches, authorization),
  };
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred was not initialized');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
