import type { Role } from '@pertexo/workflow-model';

import 'reflect-metadata';
import { vi } from 'vitest';

import { createWorkflowInputCaseTag } from '@pertexo/contracts';
import type { WorkflowInputCaseDatabase } from '@pertexo/core/authoring';
import { WorkflowInputCasesUseCase } from '../../../../src/workflow-authoring/input-cases/use-case.js';

import { createActorContext } from '../../../../src/authorization/index.js';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const caseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const versionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'input-case-test',
});

export const item = {
  id: caseId,
  workspaceId,
  workflowId,
  workflowVersionId: versionId,
  versionChecksum: `wf:sha256:${'a'.repeat(64)}`,
  name: 'Synthetic',
  revision: 1,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
};

export const context = { actor, routeWorkspaceId: workspaceId, workflowId };

export const representationTag = createWorkflowInputCaseTag(caseId, 1);

export const result = { caseId, revision: 2, replayed: true };

export function fixture(role: Role = 'owner') {
  const persistence = {
    listCases: vi.fn().mockResolvedValue({
      items: [item],
      nextCursor: { createdAt: item.createdAt, id: caseId },
    }),
    getCase: vi
      .fn()
      .mockResolvedValue({ case: { ...item, input: { value: 1 } } }),
    createCase: vi.fn().mockResolvedValue(result),
    updateCase: vi.fn().mockResolvedValue(result),
    deleteCase: vi.fn().mockResolvedValue(result),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies WorkflowInputCaseDatabase;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return {
    persistence,
    authorization,
    cases: new WorkflowInputCasesUseCase(persistence, authorization),
  };
}
