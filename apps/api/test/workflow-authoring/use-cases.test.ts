import { describe, expect, it, vi } from 'vitest';

import {
  CreateWorkflowUseCase,
  GetWorkflowUseCase,
  GetWorkflowDraftUseCase,
  InvalidWorkflowCursorError,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from '../../src/workflow-authoring/use-cases.js';
import { createDraftRepresentationTag } from '../../src/workflow-authoring/etag.js';
import {
  authorizeWorkspace,
  createActorContext,
} from '../../src/workspaces/index.js';
import type { WorkflowAuthoringPersistence } from '../../src/workflow-authoring/ports.js';
import type {
  PublishWorkflowInput as DatabasePublishWorkflowInput,
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from '@pertexo/database/testing';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '@pertexo/database/testing';
import { TransitionWorkflowLifecycleUseCase } from '../../src/workflow-authoring/lifecycle-use-case.js';
import { RenameWorkflowUseCase } from '../../src/workflow-authoring/rename-use-case.js';
import { RestoreWorkflowVersionUseCase } from '../../src/workflow-authoring/restore-version-use-case.js';

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
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
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

function authorization(
  overrides: Partial<{
    actorId: string;
    workspaceId: string;
    role: 'owner' | 'builder' | 'operator' | 'viewer';
    membershipStatus: 'active' | 'suspended';
    workspaceStatus: 'active' | 'suspended' | 'pending_deletion';
  }> = {},
) {
  return {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role: 'owner' as const,
      membershipStatus: 'active' as const,
      workspaceStatus: 'active' as const,
      ...overrides,
    }),
  };
}

function persistence(overrides: Partial<WorkflowAuthoringPersistence> = {}) {
  return {
    restoreWorkflowVersion: vi.fn().mockResolvedValue(draft({ revision: 2 })),
    transitionWorkflowLifecycle: vi
      .fn()
      .mockResolvedValue({ workflow: workflow(), replayed: false }),
    renameWorkflow: vi.fn().mockResolvedValue({
      workflow: { ...workflow(), name: 'Invoices', nameRevision: 2 },
      replayed: false,
    }),
    createWorkflow: vi.fn().mockResolvedValue({
      workflowId,
      workflow: workflow(),
      draft: draft(),
    }),
    listWorkflows: vi.fn().mockResolvedValue({ items: [workflow()] }),
    getWorkflow: vi.fn().mockResolvedValue(workflow()),
    getDraft: vi.fn().mockResolvedValue(draft()),
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

/** Roles and states that may neither publish nor edit an active workflow. */
const MUTATION_DENIALS = [
  { role: 'viewer', workspaceStatus: 'active', membershipStatus: 'active' },
  { role: 'operator', workspaceStatus: 'active', membershipStatus: 'active' },
  { role: 'owner', workspaceStatus: 'suspended', membershipStatus: 'active' },
  {
    role: 'owner',
    workspaceStatus: 'pending_deletion',
    membershipStatus: 'active',
  },
  { role: 'owner', workspaceStatus: 'active', membershipStatus: 'suspended' },
] as const;

describe('workflow authoring application seams', () => {
  it('reads one workflow without relying on list pagination', async () => {
    const store = persistence();
    const result = await new GetWorkflowUseCase(store, authorization()).execute(
      {
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      },
    );
    expect(result.workflow.name).toBe('Operations');
    expect(store.getWorkflow).toHaveBeenCalledWith(
      workspaceId,
      workflowId,
      actorId,
    );
  });

  it('fails closed when an individually requested workflow is not visible', async () => {
    const store = persistence({ getWorkflow: vi.fn().mockResolvedValue(null) });

    await expect(
      new GetWorkflowUseCase(store, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it('restores a version through one atomic command preserving the original tag', async () => {
    const store = persistence();
    const representationTag = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });
    const result = await new RestoreWorkflowVersionUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      versionId: version().id,
      representationTag,
      request: {},
    });
    expect(store.restoreWorkflowVersion).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      versionId: version().id,
      actorId,
      representationTag,
      requestId: actor.requestId,
    });
    expect(result.body.revision).toBe(2);
    expect(result.representationTag).not.toBe(representationTag);
    expect(store.getDraft).not.toHaveBeenCalled();
    expect(store.publishWorkflow).not.toHaveBeenCalled();
  });

  it('forwards preauthorization and trace context for restore and lifecycle commands', async () => {
    const store = persistence();
    const access = authorization();
    const tracedActor = { ...actor, traceId: 'trace-42' };
    const authorizedWorkspace = await authorizeWorkspace({
      actor: tracedActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:update',
      access,
      disclosure: 'not_found',
    });
    const representationTag = createDraftRepresentationTag({
      workflowId,
      revision: 1,
      graph,
      compatibilityFingerprint: fingerprint,
    });

    await new RestoreWorkflowVersionUseCase(store, access).execute({
      actor: tracedActor,
      authorizedWorkspace,
      routeWorkspaceId: workspaceId,
      workflowId,
      versionId: version().id,
      representationTag,
      request: {},
    });
    const lifecycleAuthorization = await authorizeWorkspace({
      actor: tracedActor,
      routeWorkspaceId: workspaceId,
      capability: 'workflow:publish',
      access,
      disclosure: 'not_found',
    });
    await new TransitionWorkflowLifecycleUseCase(store, access).execute({
      actor: tracedActor,
      authorizedWorkspace: lifecycleAuthorization,
      routeWorkspaceId: workspaceId,
      workflowId,
      command: 'archive',
      request: { expectedLifecycleRevision: 1 },
      idempotencyKey: 'lifecycle-trace',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    });

    expect(store.restoreWorkflowVersion).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-42' }),
    );
    expect(store.transitionWorkflowLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'trace-42',
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      }),
    );
  });

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
      ).rejects.toBeInstanceOf(Error);
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
    const store = persistence({ getDraft: vi.fn().mockResolvedValue(null) });
    const access = authorization();
    const common = { actor, routeWorkspaceId: workspaceId, workflowId };

    await expect(
      new GetWorkflowDraftUseCase(store, access).execute(common),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      new SaveWorkflowDraftUseCase(store, access).execute({
        ...common,
        representationTag:
          '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
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

  it('hashes the exact canonical publish identity and excludes diagnostic transport fields', async () => {
    const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';
    const publishWorkflow = vi.fn().mockResolvedValue({
      version: version(),
      reused: false,
      replayed: false,
    });
    const useCase = new PublishWorkflowUseCase(
      persistence({ publishWorkflow }),
      authorization(),
    );
    const base = {
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag: tag,
      idempotencyKey: 'publish-hash',
    } as const;

    await useCase.execute(base);
    const expected =
      '5fc86496b8eb735fb38c90193e9736c63ea84bb96812b35651069abbaf47b03e';
    expect(publishWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestHash: expected }),
    );
    await useCase.execute({
      ...base,
      requestId: 'diagnostic-request',
      traceId: 'diagnostic-trace',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    });
    expect(publishWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestHash: expected }),
    );
  });

  it('changes the canonical publish hash for actor, workspace, workflow, and original tag identity', async () => {
    const tag = '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"';
    const actorTwoId = '11111111-1111-4111-8111-111111111111';
    const workspaceTwoId = '22222222-2222-4222-8222-222222222222';
    const workflowTwoId = '33333333-3333-4333-8333-333333333333';
    const tagTwo = '"draft-v1.1234567890abcdefghijklmnopqrstuvwxyz_-ABCDE"';
    const hashes: string[] = [];
    const execute = async (
      inputActor: typeof actor,
      routeWorkspaceId: string,
      inputWorkflowId: string,
      representationTag: string,
      access = authorization({
        actorId: inputActor.actorId,
        workspaceId: routeWorkspaceId,
      }),
    ) => {
      const publishWorkflow = vi.fn((input: DatabasePublishWorkflowInput) => {
        hashes.push(input.requestHash);
        return Promise.resolve({
          version: version(),
          reused: false,
          replayed: false,
        });
      });
      await new PublishWorkflowUseCase(
        persistence({ publishWorkflow }),
        access,
      ).execute({
        actor: inputActor,
        routeWorkspaceId,
        workflowId: inputWorkflowId,
        representationTag,
        idempotencyKey: 'publish-hash-sensitivity',
      });
    };

    await execute(actor, workspaceId, workflowId, tag);
    await execute(
      createActorContext({
        actorId: actorTwoId,
        workspaceId,
        sessionId,
        requestId: 'actor-two',
      }),
      workspaceId,
      workflowId,
      tag,
    );
    await execute(
      createActorContext({
        actorId,
        workspaceId: workspaceTwoId,
        sessionId,
        requestId: 'workspace-two',
      }),
      workspaceTwoId,
      workflowId,
      tag,
    );
    await execute(actor, workspaceId, workflowTwoId, tag);
    await execute(actor, workspaceId, workflowId, tagTwo);

    expect(new Set(hashes).size).toBe(5);
  });

  it('lets persistence resolve an exact publish replay before reading a fresh draft', async () => {
    const getDraft = vi
      .fn()
      .mockRejectedValue(
        new Error('publish replay must not perform a fresh draft read'),
      );
    const publishWorkflow = vi.fn().mockResolvedValue({
      version: version(),
      reused: true,
      replayed: true,
    });
    const store = persistence({ getDraft, publishWorkflow });
    const result = await new PublishWorkflowUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag:
        '"draft-v1.abcdefghijklmnopqrstuvwxyz0123456789_-abcde"',
      idempotencyKey: 'publish-replay-42',
    });

    expect(result.reused).toBe(true);
    expect(publishWorkflow).toHaveBeenCalledOnce();
    expect(getDraft).not.toHaveBeenCalled();
  });

  it('reports a CAS conflict revision and ETag from one persistence snapshot', async () => {
    const currentEtag = createDraftRepresentationTag({
      workflowId,
      revision: 2,
      graph,
      compatibilityFingerprint: fingerprint,
    });
    const getDraft = vi.fn().mockResolvedValue(draft());
    const saveDraft = vi
      .fn()
      .mockRejectedValue(new WorkflowRevisionConflictError(2, currentEtag));
    const store = persistence({ getDraft, saveDraft });
    const failure = await new SaveWorkflowDraftUseCase(store, authorization())
      .execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        representationTag: createDraftRepresentationTag({
          workflowId,
          revision: 1,
          graph,
          compatibilityFingerprint: fingerprint,
        }),
        graph,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowRevisionConflictError);
    if (!(failure instanceof WorkflowRevisionConflictError))
      throw new Error('expected workflow revision conflict');
    expect(failure.currentRevision).toBe(2);
    expect(failure.currentEtag).toBe(currentEtag);
    expect(getDraft).toHaveBeenCalledOnce();
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
      getDraft: vi.fn().mockResolvedValue(draft({ compatibility })),
    });

    await expect(
      new ValidateWorkflowDraftUseCase(store, authorization()).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
      }),
    ).resolves.toEqual({ valid: false, issues: [], compatibility });
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
          schemaVersion: 1,
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

  it('keeps recently-updated cursors distinct from created-order cursors', async () => {
    const cursor = {
      positionAt: '2026-08-21T12:00:00.000900Z',
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
      order: 'updated_desc',
    });
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      order: 'updated_desc',
      after: first.nextCursor ?? '',
    });
    expect(listWorkflows).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: cursor, order: 'updated_desc' }),
    );
    await expect(
      useCase.execute({
        actor,
        routeWorkspaceId: workspaceId,
        after: first.nextCursor ?? '',
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
  });

  it('rejects cursor payload fields outside the feature-private contract', async () => {
    const listWorkflows = vi.fn();
    const useCase = new ListWorkflowsUseCase(
      persistence({ listWorkflows }),
      authorization(),
    );
    const cursor = Buffer.from(
      JSON.stringify({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
        unexpected: true,
      }),
      'utf8',
    ).toString('base64url');

    await expect(
      useCase.execute({ actor, routeWorkspaceId: workspaceId, after: cursor }),
    ).rejects.toMatchObject({ name: 'InvalidWorkflowCursorError' });
    expect(listWorkflows).not.toHaveBeenCalled();
  });

  it('keeps workflow and version cursor variants distinct', async () => {
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce({
        items: [version()],
        nextCursor: { beforeVersionNumber: 2 },
      })
      .mockResolvedValueOnce({ items: [] });
    const useCase = new ListWorkflowVersionsUseCase(
      persistence({ listVersions }),
      authorization(),
    );

    const first = await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
    });
    expect(first.nextCursor).toBe(
      'eyJraW5kIjoidmVyc2lvbnMiLCJiZWZvcmVWZXJzaW9uTnVtYmVyIjoyfQ',
    );
    await useCase.execute({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      after: first.nextCursor ?? '',
    });

    expect(listVersions).toHaveBeenLastCalledWith(
      expect.objectContaining({ beforeVersionNumber: 2 }),
    );
  });

  it.each([
    { name: 'empty input', cursor: '' },
    {
      name: 'malformed decoded JSON',
      cursor: Buffer.from('{', 'utf8').toString('base64url'),
    },
    {
      name: 'the version variant',
      cursor: encodedCursor({ kind: 'versions', beforeVersionNumber: 2 }),
    },
    {
      name: 'an unknown field',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
        unknown: true,
      }),
    },
    {
      name: 'an absent date',
      cursor: encodedCursor({ kind: 'workflow', id: workflowId }),
    },
    {
      name: 'an invalid date',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: 'not-a-date',
        id: workflowId,
      }),
    },
    {
      name: 'an invalid workflow ID',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: 'not-a-uuid',
      }),
    },
  ])(
    'rejects workflow cursor with $name before listing',
    async ({ cursor }) => {
      const listWorkflows = vi.fn();
      await expect(
        new ListWorkflowsUseCase(
          persistence({ listWorkflows }),
          authorization(),
        ).execute({ actor, routeWorkspaceId: workspaceId, after: cursor }),
      ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
      expect(listWorkflows).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'the workflow variant',
      cursor: encodedCursor({
        kind: 'workflow',
        createdAt: '2026-08-20T12:00:00.000Z',
        id: workflowId,
      }),
    },
    {
      name: 'an absent version',
      cursor: encodedCursor({ kind: 'versions' }),
    },
    {
      name: 'a zero version',
      cursor: encodedCursor({ kind: 'versions', beforeVersionNumber: 0 }),
    },
    {
      name: 'a fractional version',
      cursor: encodedCursor({ kind: 'versions', beforeVersionNumber: 1.5 }),
    },
    {
      name: 'an unknown field',
      cursor: encodedCursor({
        kind: 'versions',
        beforeVersionNumber: 2,
        unknown: true,
      }),
    },
  ])('rejects version cursor with $name before listing', async ({ cursor }) => {
    const listVersions = vi.fn();
    await expect(
      new ListWorkflowVersionsUseCase(
        persistence({ listVersions }),
        authorization(),
      ).execute({
        actor,
        routeWorkspaceId: workspaceId,
        workflowId,
        after: cursor,
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('projects one create command and its returned workflow plus empty draft', async () => {
    const store = persistence();
    const result = await new CreateWorkflowUseCase(
      store,
      authorization(),
    ).execute({
      actor,
      routeWorkspaceId: workspaceId,
      request: { name: ' Operations ' },
      idempotencyKey: 'create-42',
    });
    expect(result.body).toMatchObject({
      workflow: { id: workflowId, name: 'Operations' },
      draft: { workflowId, revision: 1 },
    });
    expect(result.representationTag).toMatch(/^"draft-v1\./u);
    expect(store.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        emptyGraph: graph,
        idempotencyKey: 'create-42',
      }),
    );
  });
});

function encodedCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
