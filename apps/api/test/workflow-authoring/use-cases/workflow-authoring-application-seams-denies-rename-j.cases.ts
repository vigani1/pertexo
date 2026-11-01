import { expect, it, vi } from 'vitest';
import {
  CreateWorkflowUseCase,
  GetWorkflowDraftUseCase,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from '../../../src/workflow-authoring/use-cases.js';
import { createDraftRepresentationTag } from '../../../src/workflow-authoring/http/etag.js';
import { authorizeWorkspace } from '../../../src/authorization/index.js';

import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/core/testing';

import { RenameWorkflowUseCase } from '../../../src/workflow-authoring/commands/rename.js';

import {
  actorId,
  workspaceId,
  workflowId,
  fingerprint,
  graph,
  actor,
  authorization,
  persistence,
  MUTATION_DENIALS,
} from './fixture.js';

export function registerWorkflowAuthoringApplicationSeamsDeniesRenameJ(): void {
  it.each(MUTATION_DENIALS)('denies a rename with %j', async (denial) => {
    const store = persistence();
    const access = authorization();
    access.findAccess.mockResolvedValue({ actorId, workspaceId, ...denial });
    await expect(
      new RenameWorkflowUseCase(store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        request: { name: 'Invoices', expectedNameRevision: 1 },
        idempotencyKey: 'key',
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(store.renameWorkflow).not.toHaveBeenCalled();
  });

  it('reuses guard authorization without repeating the access lookup', async () => {
    const access = authorization();
    const authorizedWorkspace = await authorizeWorkspace({
      actor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:read',
      access,
      disclosure: 'not_found',
    });

    await new ListWorkflowsUseCase(persistence(), access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      authorizedWorkspace,
    });

    expect(access.findAccess).toHaveBeenCalledTimes(1);
  });

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

  it('fails closed when each draft read seam reports no visible workflow', async () => {
    const store = persistence({
      getDraft: vi.fn().mockResolvedValue(null),
      validateDraft: vi.fn().mockResolvedValue(null),
    });
    const access = authorization();
    const common = { actor, routeWorkspaceId: workspaceId, workflowId };

    await expect(
      new GetWorkflowDraftUseCase(store, access).execute(common),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      new SaveWorkflowDraftUseCase(store, access).execute({
        ...common,
        representationTag:
          '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
        graph,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      new ValidateWorkflowDraftUseCase(store, access).execute(common),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    expect(store.saveDraft).not.toHaveBeenCalled();
  });

  it('forwards optional bounds and request trace context through public use cases', async () => {
    const store = persistence();
    const access = authorization();
    const representationTag = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });

    await new ListWorkflowsUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      limit: 10,
      order: 'updated_desc',
    });
    await new CreateWorkflowUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      request: { name: 'Operations' },
      idempotencyKey: 'create-optional-context',
      requestId: 'request-create',
      traceId: 'trace-create',
    });
    await new SaveWorkflowDraftUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag,
      graph,
      requestId: 'request-save',
      traceId: 'trace-save',
    });
    await new PublishWorkflowUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag,
      idempotencyKey: 'publish-optional-context',
      requestId: 'request-publish',
      traceId: 'trace-publish',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    });
    await new ListWorkflowVersionsUseCase(store, access).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      limit: 5,
    });

    expect(store.listWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, order: 'updated_desc' }),
    );
    expect(store.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-create',
        traceId: 'trace-create',
      }),
    );
    expect(store.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-save',
        traceId: 'trace-save',
      }),
    );
    expect(store.publishWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-publish',
        traceId: 'trace-publish',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    );
    expect(store.listVersions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
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
      expect.objectContaining({
        representationTag: expected,
        expectedRevision: 1,
        graphJson: graph,
      }),
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
          '"draft.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
        graph,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowRevisionConflictError);
    if (!(failure instanceof WorkflowRevisionConflictError))
      throw new Error('expected workflow revision conflict');
    expect(failure.currentRevision).toBe(1);
    expect(failure.currentEtag).toMatch(/^"draft\./u);
    expect(store.saveDraft).not.toHaveBeenCalled();
  });
}
