import { describe, expect, it, vi } from 'vitest';

import {
  CreateWorkflowUseCase,
  GetWorkflowDraftUseCase,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from '../../src/workflow-authoring/use-cases.js';
import { createDraftRepresentationTag } from '../../src/workflow-authoring/etag.js';
import { createActorContext } from '../../src/workspaces/index.js';
import type { WorkflowAuthoringPersistence } from '../../src/workflow-authoring/ports.js';
import type {
  PublishWorkflowInput as DatabasePublishWorkflowInput,
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/database';
import { WorkflowRevisionConflictError } from '@pertexo/database';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fingerprint =
  'wf-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const graph = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  settings: {},
} as const;

const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId,
  requestId: 'request-42',
});

function draft(
  overrides: Partial<WorkflowDraftRecord> = {},
): WorkflowDraftRecord {
  return {
    workflowId,
    workspaceId,
    revision: 1,
    schemaVersion: 1,
    graphJson: graph,
    compatibility: { compatible: true, fingerprint, issues: [] },
    updatedBy: actorId,
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    ...overrides,
  };
}

function workflow(): WorkflowRecord {
  return {
    id: workflowId,
    workspaceId,
    name: 'Operations',
    lifecycleStatus: 'active',
    activationStatus: 'inactive',
    publishedVersionId: null,
    createdBy: actorId,
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

function version(): WorkflowVersionRecord {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    workspaceId,
    workflowId,
    versionNumber: 1,
    schemaVersion: 1,
    graphJson: graph,
    checksum:
      'wf:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    publishedBy: actorId,
    publishedAt: new Date('2026-08-20T12:00:00.000Z'),
  };
}

function authorization() {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
    }),
  };
}

function persistence(overrides: Partial<WorkflowAuthoringPersistence> = {}) {
  return {
    createWorkflow: vi.fn().mockResolvedValue({
      workflowId,
      workflow: workflow(),
      draft: draft(),
    }),
    listWorkflows: vi.fn().mockResolvedValue({ items: [workflow()] }),
    getDraft: vi.fn().mockResolvedValue(draft()),
    getVersion: vi.fn(),
    listVersions: vi.fn().mockResolvedValue({ items: [version()] }),
    saveDraft: vi.fn().mockResolvedValue(draft({ revision: 2 })),
    publishWorkflow: vi.fn().mockResolvedValue({
      version: version(),
      reused: false,
      replayed: false,
    }),
    ...overrides,
  } satisfies WorkflowAuthoringPersistence;
}

describe('workflow authoring application seams', () => {
  it('hides a route workspace mismatch through not-found authorization and does not touch persistence', async () => {
    const store = persistence();
    const access = authorization();
    const useCase = new GetWorkflowDraftUseCase(store, access);

    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        workflowId,
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(access.findAccess).not.toHaveBeenCalled();
  });

  it('returns a strong ETag on draft reads and uses the same codec for a matching save', async () => {
    const store = persistence();
    const access = authorization();
    const get = new GetWorkflowDraftUseCase(store, access);
    const save = new SaveWorkflowDraftUseCase(store, access);
    const read = await get.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
    });
    const expected = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      schemaVersion: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });
    expect(read.representationTag).toBe(expected);
    const saved = await save.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag: expected,
      graph,
    });
    expect(saved.body.revision).toBe(2);
    expect(store.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 1, graphJson: graph }),
    );
  });

  it('rejects a stale save before mutation and includes the current validator details', async () => {
    const store = persistence();
    const access = authorization();
    const save = new SaveWorkflowDraftUseCase(store, access);

    const failure = await save
      .execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        representationTag:
          '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
        graph,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowRevisionConflictError);
    if (!(failure instanceof WorkflowRevisionConflictError))
      throw new Error('expected workflow revision conflict');
    expect(failure.currentRevision).toBe(1);
    expect(failure.currentEtag).toMatch(/^"draft-v1\./u);
    expect(store.saveDraft).not.toHaveBeenCalled();
  });

  it('passes the opaque publish tag to persistence without pre-rejecting it', async () => {
    let publishInput: DatabasePublishWorkflowInput | undefined;
    const store = persistence({
      publishWorkflow: (input) => {
        publishInput = input;
        return Promise.resolve({
          version: version(),
          reused: false,
          replayed: false,
        });
      },
    });
    const useCase = new PublishWorkflowUseCase(store, authorization());
    const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';

    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag: tag,
      idempotencyKey: 'publish-42',
    });
    expect(publishInput?.representationTag).toBe(tag);
    expect(publishInput?.idempotencyKey).toBe('publish-42');
    expect(publishInput?.requestHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('uses named read capability for list, validate, and version listing', async () => {
    const access = authorization();
    const store = persistence();
    await new ListWorkflowsUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
    });
    await new ValidateWorkflowDraftUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
    });
    await new ListWorkflowVersionsUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
    });
    expect(access.findAccess).toHaveBeenCalledTimes(3);
    expect(access.findAccess).toHaveBeenCalledWith({ actorId, workspaceId });
  });

  it('creates the atomic workflow plus empty draft returned by persistence', async () => {
    const store = persistence();
    const result = await new CreateWorkflowUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      name: ' Operations ',
      idempotencyKey: 'create-42',
    });
    expect(result).toMatchObject({
      workflow: { id: workflowId, name: 'Operations' },
      draft: { workflowId, revision: 1 },
    });
    expect(store.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        emptyGraph: graph,
        idempotencyKey: 'create-42',
      }),
    );
  });
});
