import { expect, it, vi } from 'vitest';

import { createDraftRepresentationTag } from '../../../src/workflow-authoring/http/etag.js';
import { authorizeWorkspace } from '../../../src/authorization/index.js';

import { TransitionWorkflowLifecycleUseCase } from '../../../src/workflow-authoring/commands/lifecycle.js';
import { RenameWorkflowUseCase } from '../../../src/workflow-authoring/commands/rename.js';
import { RestoreWorkflowVersionUseCase } from '../../../src/workflow-authoring/commands/restore-version.js';

import {
  actorId,
  workspaceId,
  workflowId,
  fingerprint,
  graph,
  actor,
  workflow,
  version,
  authorization,
  persistence,
  MUTATION_DENIALS,
} from './fixture.js';

export function registerRejectsMalformedVersionRestoreBodyJ(): void {
  it.each(
    [null, [], { graph }, { expectedRevision: 1 }].map((request) => ({
      request,
    })),
  )(
    'rejects malformed version restore body %j before persistence',
    async ({ request }) => {
      const store = persistence();
      await expect(
        new RestoreWorkflowVersionUseCase(store, authorization()).execute({
          actor,
          routeWorkspaceId: workspaceId,
          workflowId,
          versionId: version().id,
          representationTag: createDraftRepresentationTag({
            workflowId,
            revision: 1,
            graph,
            compatibilityFingerprint: fingerprint,
          }),
          request,
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(store.restoreWorkflowVersion).not.toHaveBeenCalled();
    },
  );

  it.each(['archive', 'restore'] as const)(
    'accepts %s using publication authority and serializes the durable response',
    async (command) => {
      const store = persistence();
      const access = authorization();
      const accepted = {
        ...workflow(),
        lifecycleRevision: 2,
        lifecycleStatus:
          command === 'archive' ? ('archived' as const) : ('active' as const),
      };
      vi.mocked(store.transitionWorkflowLifecycle).mockResolvedValue({
        workflow: accepted,
        replayed: true,
      });
      const result = await new TransitionWorkflowLifecycleUseCase(
        store,
        access,
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        command,
        request: { expectedLifecycleRevision: 1 },
        idempotencyKey: 'lifecycle-key',
      });
      expect(store.transitionWorkflowLifecycle).toHaveBeenCalledExactlyOnceWith(
        {
          workspaceId,
          workflowId,
          actorId,
          command,
          expectedLifecycleRevision: 1,
          idempotencyKey: 'lifecycle-key',
          requestId: actor.requestId,
        },
      );
      expect(result).toMatchObject({
        workflow: {
          lifecycleRevision: 2,
          lifecycleStatus: accepted.lifecycleStatus,
        },
        replayed: true,
      });
      expect(result.workflow).not.toHaveProperty('createdBy');
      expect(store.getDraft).not.toHaveBeenCalled();
      expect(store.publishWorkflow).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { expectedLifecycleRevision: 0 },
    { expectedLifecycleRevision: 1.1 },
    { expectedLifecycleRevision: '1' },
    { expectedLifecycleRevision: Number.MAX_SAFE_INTEGER + 1 },
    { expectedLifecycleRevision: 1, cancelRuns: true },
  ])(
    'rejects malformed lifecycle input before persistence: %j',
    async (request) => {
      const store = persistence();
      await expect(
        new TransitionWorkflowLifecycleUseCase(store, authorization()).execute({
          actor,
          routeWorkspaceId: workspaceId,
          workflowId,
          command: 'archive',
          request,
          idempotencyKey: 'key',
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(store.transitionWorkflowLifecycle).not.toHaveBeenCalled();
    },
  );

  it.each(MUTATION_DENIALS)(
    'denies lifecycle mutation with %j',
    async (denial) => {
      const store = persistence();
      const access = authorization();
      access.findAccess.mockResolvedValue({ actorId, workspaceId, ...denial });
      await expect(
        new TransitionWorkflowLifecycleUseCase(store, access).execute({
          actor,
          routeWorkspaceId: workspaceId,
          workflowId,
          command: 'restore',
          request: { expectedLifecycleRevision: 1 },
          idempotencyKey: 'key',
        }),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
      expect(store.transitionWorkflowLifecycle).not.toHaveBeenCalled();
    },
  );

  it('renames with editing authority and serializes the accepted summary', async () => {
    const store = persistence();
    const access = authorization({ role: 'builder' });
    const tracedActor = { ...actor, traceId: 'trace-41' };
    const authorizedWorkspace = await authorizeWorkspace({
      actor: tracedActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });

    const result = await new RenameWorkflowUseCase(store, access).execute({
      actor: tracedActor,
      authorizedWorkspace,
      routeWorkspaceId: workspaceId,
      workflowId,
      request: { name: '  Invoices  ', expectedNameRevision: 1 },
      idempotencyKey: 'rename-key',
    });

    expect(store.renameWorkflow).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
      name: 'Invoices',
      expectedNameRevision: 1,
      idempotencyKey: 'rename-key',
      requestId: actor.requestId,
      traceId: 'trace-41',
    });
    expect(access.findAccess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      workflow: { name: 'Invoices', nameRevision: 2 },
      replayed: false,
    });
    expect(result.workflow).not.toHaveProperty('createdBy');
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.transitionWorkflowLifecycle).not.toHaveBeenCalled();
  });

  it('forwards an untraced rename and returns a replayed receipt unchanged', async () => {
    const replayed = { ...workflow(), name: 'Invoices', nameRevision: 2 };
    const store = persistence({
      renameWorkflow: vi
        .fn()
        .mockResolvedValue({ workflow: replayed, replayed: true }),
    });

    await expect(
      new RenameWorkflowUseCase(store, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        request: { name: 'Invoices', expectedNameRevision: 1 },
        idempotencyKey: 'rename-replay',
      }),
    ).resolves.toMatchObject({
      workflow: { name: 'Invoices', nameRevision: 2 },
      replayed: true,
    });
    expect(
      vi.mocked(store.renameWorkflow).mock.calls[0]?.[0],
    ).not.toHaveProperty('traceId');
  });

  it.each([
    {},
    { name: 'Invoices' },
    { name: '   ', expectedNameRevision: 1 },
    { name: 'x'.repeat(129), expectedNameRevision: 1 },
    { name: 'Invoices', expectedNameRevision: 0 },
    { name: 'Invoices', expectedNameRevision: '1' },
    { name: 'Invoices', expectedNameRevision: 1, expectedLifecycleRevision: 1 },
  ])(
    'rejects malformed rename input before persistence: %j',
    async (request) => {
      const store = persistence();
      await expect(
        new RenameWorkflowUseCase(store, authorization()).execute({
          actor,
          routeWorkspaceId: workspaceId,
          workflowId,
          request,
          idempotencyKey: 'key',
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(store.renameWorkflow).not.toHaveBeenCalled();
    },
  );
}
