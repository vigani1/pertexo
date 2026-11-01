import { expect, it, vi } from 'vitest';
import {
  GetWorkflowDraftUseCase,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from '../../../src/workflow-authoring/use-cases.js';
import { createDraftRepresentationTag } from '../../../src/workflow-authoring/http/etag.js';

import type { WorkflowRecord } from '@pertexo/core/testing';

import {
  actorId,
  workspaceId,
  workflowId,
  fingerprint,
  graph,
  actor,
  draft,
  workflow,
  version,
  authorization,
  persistence,
} from './fixture.js';

export function registerUsesNamedReadCapabilityListValidate(): void {
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

  it('allows viewer reads while denying update and publish capabilities before persistence', async () => {
    const access = authorization({ role: 'viewer' });
    const store = persistence();
    await expect(
      new GetWorkflowDraftUseCase(store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).resolves.toMatchObject({ body: { workflowId } });

    const representationTag = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });
    await expect(
      new SaveWorkflowDraftUseCase(store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        representationTag,
        graph,
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    await expect(
      new PublishWorkflowUseCase(store, access).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        representationTag,
        idempotencyKey: 'viewer-publish',
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(store.saveDraft).not.toHaveBeenCalled();
    expect(store.publishWorkflow).not.toHaveBeenCalled();
  });

  it('marks a structurally valid graph invalid when selected compatibility rejects it', async () => {
    const compatibility = {
      compatible: false,
      fingerprint,
      issues: [
        {
          code: 'unknown_definition' as const,
          definitionKey: 'retired.node',
          version: 1,
        },
      ],
    };
    const store = persistence({
      validateDraft: vi.fn().mockResolvedValue({
        currentPublication: null,
        draft: draft({ compatibility }),
        validation: {
          ok: true,
          issues: [],
          expandedInvocations: 0,
          worstCaseLoopIterations: 0,
        },
      }),
    });

    await expect(
      new ValidateWorkflowDraftUseCase(store, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).resolves.toMatchObject({
      body: { valid: false, issues: [], compatibility },
    });
  });

  it('serializes exact workflow and version allowlists, retained graph, and timestamps', async () => {
    const store = persistence();
    const workflows = await new ListWorkflowsUseCase(
      store,
      authorization(),
    ).execute({ actor, routeWorkspaceId: workspaceId });
    const versions = await new ListWorkflowVersionsUseCase(
      store,
      authorization(),
    ).execute({ actor, routeWorkspaceId: workspaceId, workflowId });

    expect(workflows).toEqual({
      items: [
        {
          id: workflowId,
          workspaceId,
          name: 'Operations',
          nameRevision: 1,
          lifecycleStatus: 'active',
          lifecycleRevision: 1,
          activationStatus: 'inactive',
          webhookSetupRequired: false,
          publishedVersionId: null,
          createdAt: '2026-08-20T12:00:00.000Z',
          updatedAt: '2026-08-20T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(versions).toEqual({
      items: [
        {
          id: version().id,
          workflowId,
          versionNumber: 1,
          graph,
          checksum: version().checksum,
          publishedAt: '2026-08-20T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(workflows.items[0]).not.toHaveProperty('createdBy');
    expect(versions.items[0]).not.toHaveProperty('workspaceId');
    expect(versions.items[0]).not.toHaveProperty('publishedBy');
  });

  it('returns exact empty pages and rejects an invalid persistence projection', async () => {
    const emptyStore = persistence({
      listWorkflows: vi.fn().mockResolvedValue({ items: [] }),
      listVersions: vi.fn().mockResolvedValue({ items: [] }),
    });
    await expect(
      new ListWorkflowsUseCase(emptyStore, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      new ListWorkflowVersionsUseCase(emptyStore, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    const invalid = {
      ...workflow(),
      lifecycleStatus: 'deleted',
    } as unknown as WorkflowRecord;
    const invalidStore = persistence({
      listWorkflows: vi.fn().mockResolvedValue({ items: [invalid] }),
    });
    await expect(
      new ListWorkflowsUseCase(invalidStore, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('round-trips the opaque workflow list cursor through the public use case', async () => {
    const cursor = {
      positionAt: '2026-08-20T12:00:00.000Z',
      id: workflowId,
    };
    const listWorkflows = vi
      .fn()
      .mockResolvedValueOnce({ items: [workflow()], nextCursor: cursor })
      .mockResolvedValueOnce({ items: [] });
    const useCase = new ListWorkflowsUseCase(
      persistence({ listWorkflows }),
      authorization(),
    );

    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
    });
    expect(first.nextCursor).toBe(
      'eyJraW5kIjoid29ya2Zsb3ciLCJjcmVhdGVkQXQiOiIyMDI2LTA4LTIwVDEyOjAwOjAwLjAwMFoiLCJpZCI6ImRkZGRkZGRkLWRkZGQtNGRkZC04ZGRkLWRkZGRkZGRkZGRkZCJ9',
    );
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      after: first.nextCursor ?? '',
    });

    expect(listWorkflows).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: cursor }),
    );
  });
}
