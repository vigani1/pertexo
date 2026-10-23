import { WorkflowLifecycleController } from '../../../../src/workflow-authoring/http/lifecycle-controller.js';
import { WorkflowVersionsController } from '../../../../src/workflow-authoring/http/versions-controller.js';
import { vi } from 'vitest';
import { WorkflowAuthoringController } from '../../../../src/workflow-authoring/http/controllers.js';

export const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

export const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const guardActorId = '99999999-9999-4999-8999-999999999999';

export const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const tag = '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';

export const body = {
  workflowId,
  revision: 1,
  graph: { nodes: [], edges: [], settings: {} },
  compatibility: {
    compatible: true,
    fingerprint:
      'wf-compat:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    issues: [],
  },
  updatedAt: '2026-08-20T12:00:00.000Z',
};

export const workflow = {
  id: workflowId,
  workspaceId,
  name: 'Operations',
  nameRevision: 1,
  lifecycleStatus: 'active' as const,
  lifecycleRevision: 1,
  activationStatus: 'inactive' as const,
  webhookSetupRequired: false,
  publishedVersionId: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
};

export const version = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  workflowId,
  versionNumber: 1,
  graph: body.graph,
  checksum:
    'wf:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  publishedAt: '2026-08-20T12:00:00.000Z',
};

export function request(
  headers: Record<string, string> = {},
  identifiers: Readonly<{ requestId?: string; traceId?: string }> = {},
) {
  return {
    requestId: identifiers.requestId ?? 'request-42',
    ...(identifiers.traceId === undefined
      ? {}
      : { traceId: identifiers.traceId }),
    headers,
    identitySession: {
      userId: actorId,
      sessionId,
      expiresAt: new Date('2026-08-20T20:00:00.000Z'),
      clientMetadata: {},
    },
  } as const;
}

export function makeController() {
  const duplicateWorkflow = {
    execute: vi.fn().mockResolvedValue({ workflowId }),
  };
  const listWorkflows = {
    execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const restoreVersion = {
    execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
  };
  const transitionLifecycle = {
    execute: vi.fn().mockResolvedValue({ workflow, replayed: false }),
  };
  const renameWorkflow = {
    execute: vi.fn().mockResolvedValue({ workflow, replayed: false }),
  };
  const createWorkflow = {
    execute: vi.fn().mockResolvedValue({
      body: { workflow, draft: body },
      representationTag: tag,
    }),
  };
  const getWorkflow = {
    execute: vi.fn().mockResolvedValue({ workflow }),
  };
  const saveDraft = {
    execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
  };
  const getDraft = {
    execute: vi.fn().mockResolvedValue({ body, representationTag: tag }),
  };
  const publishWorkflow = {
    execute: vi.fn().mockResolvedValue({ version, reused: false }),
  };
  const validateDraft = {
    execute: vi.fn().mockResolvedValue({
      representationTag: tag,
      body: {
        valid: true,
        currentPublication: null,
        issues: [],
        compatibility: body.compatibility,
      },
    }),
  };
  const listVersions = {
    execute: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  return {
    authoring: new WorkflowAuthoringController(
      listWorkflows as never,
      createWorkflow as never,
      getWorkflow as never,
      getDraft as never,
      saveDraft as never,
      validateDraft as never,
      publishWorkflow as never,
      {} as never,
    ),
    lifecycle: new WorkflowLifecycleController(
      transitionLifecycle as never,
      renameWorkflow as never,
      duplicateWorkflow as never,
    ),
    versions: new WorkflowVersionsController(
      listVersions as never,
      restoreVersion as never,
    ),
    transitionLifecycle,
    duplicateWorkflow,
    renameWorkflow,
    restoreVersion,
    createWorkflow,
    getWorkflow,
    getDraft,
    saveDraft,
    publishWorkflow,
    listWorkflows,
    listVersions,
    validateDraft,
  };
}
