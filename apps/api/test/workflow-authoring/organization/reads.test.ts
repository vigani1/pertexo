import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  WorkflowNotFoundError,
  WorkflowTemplateOriginUnavailableError,
  type WorkflowWithOrganization,
} from '@pertexo/database/authoring';
import {
  createActorContext,
  AuthorizationError,
} from '../../../src/authorization/index.js';
import { WorkflowOrganizationReadsUseCase } from '../../../src/workflow-authoring/organization/reads.js';
import { InvalidWorkflowCursorError } from '../../../src/workflow-authoring/cursor.js';

function fixture(role: 'owner' | 'admin' | 'builder' | 'viewer' = 'viewer') {
  const workspaceId = randomUUID(),
    actorId = randomUUID(),
    workflowId = randomUUID();
  const actor = createActorContext({
    workspaceId,
    actorId,
    sessionId: randomUUID(),
    requestId: 'organization-reads',
  });
  const input = { actor, routeWorkspaceId: workspaceId };
  const tag = { id: randomUUID(), key: 'ops', revision: 1 };
  const date = new Date('2026-10-02T08:00:00.000Z');
  const item: WorkflowWithOrganization = {
    workflow: {
      id: workflowId,
      workspaceId,
      createdBy: actorId,
      createdAt: date,
      updatedAt: date,
      name: 'Reader fixture',
      lifecycleStatus: 'active',
      activationStatus: 'inactive',
      nameRevision: 1,
      lifecycleRevision: 1,
      publishedVersionId: null,
    },
    organization: {
      tags: [tag],
      organizationRevision: 2,
      folderId: null,
      isFavorite: false,
    },
  };
  const position = {
    id: workflowId,
    positionAt: '2026-10-02T08:00:00.000001Z',
  };
  const reader = {
    listWorkflows: vi
      .fn()
      .mockResolvedValue({ items: [item], nextCursor: position }),
    getWorkflow: vi.fn().mockResolvedValue(item),
  };
  const tags = {
    listTags: vi.fn().mockResolvedValue({ items: [tag], nextId: tag.id }),
    listTagAssignments: vi.fn().mockResolvedValue({
      items: [{ workflowId, organizationRevision: 2 }],
      nextId: workflowId,
    }),
  };
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      workspaceId,
      actorId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  const origin = {
    getWorkflowWithTemplateOrigin: vi
      .fn()
      .mockResolvedValue({ workflow: item.workflow, templateOrigin: null }),
  };
  const reads = new WorkflowOrganizationReadsUseCase(
    reader,
    tags,
    authorization,
    origin,
  );
  return {
    input,
    item,
    position,
    reader,
    tags,
    tag,
    authorization,
    origin,
    reads,
  };
}

describe('workflow organization read interface', () => {
  it('normalizes filters, forwards trusted actor/signal and keeps metadata opt-in', async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    const result = await f.reads.list({
      ...f.input,
      signal,
      query: {
        query: '  Ops  ',
        view: 'active',
        tagId: f.tag.id.toUpperCase(),
        favoritesOnly: 'true',
        limit: '1',
      },
    });
    expect(f.reader.listWorkflows).toHaveBeenCalledWith({
      workspaceId: f.input.routeWorkspaceId,
      actorId: f.input.actor.actorId,
      signal,
      query: 'Ops',
      view: 'active',
      tagId: f.tag.id,
      favoritesOnly: true,
      limit: 1,
      order: 'created_asc',
    });
    expect(Object.keys(result.items[0] ?? {})).not.toContain('organization');
    const projected = await f.reads.list({
      ...f.input,
      query: { include: 'organization' },
    });
    expect(projected.items[0]).toMatchObject({
      organization: f.item.organization,
    });
  });

  it('binds normalized filters/projection/order/actor while allowing a different page limit', async () => {
    const f = fixture();
    const page = await f.reads.list({
      ...f.input,
      query: {
        query: '  Ops  ',
        view: 'all',
        include: 'organization',
        limit: 1,
      },
    });
    await f.reads.list({
      ...f.input,
      query: {
        query: 'Ops',
        include: 'organization',
        limit: 100,
        after: page.nextCursor,
      },
    });
    expect(f.reader.listWorkflows.mock.calls.at(-1)?.[0]).toMatchObject({
      after: f.position,
      limit: 100,
    });
    for (const changed of [
      { query: 'ops' },
      { include: undefined },
      { view: 'active' },
      { tagId: f.tag.id },
      { folderId: 'root' },
      { folderId: randomUUID() },
      { favoritesOnly: 'true' },
      { order: 'updated_desc' },
    ]) {
      await expect(
        f.reads.list({
          ...f.input,
          query: {
            query: 'Ops',
            include: 'organization',
            after: page.nextCursor,
            ...changed,
          },
        }),
      ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
    }
    const actor = createActorContext({
      ...f.input.actor,
      actorId: randomUUID(),
    });
    f.authorization.findAccess.mockResolvedValue({
      workspaceId: f.input.routeWorkspaceId,
      actorId: actor.actorId,
      role: 'viewer',
      membershipStatus: 'active',
      workspaceStatus: 'active',
    });
    await expect(
      f.reads.list({
        ...f.input,
        actor,
        query: {
          query: 'Ops',
          include: 'organization',
          after: page.nextCursor,
        },
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
  });

  it('rechecks authority on every page and refuses before database work after loss', async () => {
    const f = fixture();
    const page = await f.reads.list({
      ...f.input,
      query: { include: 'organization' },
    });
    f.authorization.findAccess.mockResolvedValue(undefined);
    await expect(
      f.reads.list({
        ...f.input,
        query: { include: 'organization', after: page.nextCursor },
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(f.reader.listWorkflows).toHaveBeenCalledTimes(1);
  });

  it('separates vocabulary and assignment cursor purposes and selected tag identity', async () => {
    const f = fixture('admin');
    const page = await f.reads.listTags({ ...f.input, query: { limit: 1 } });
    await f.reads.listTags({
      ...f.input,
      query: { after: page.nextCursor, limit: 2 },
    });
    expect(f.tags.listTags.mock.calls.at(-1)?.[0]).toMatchObject({
      afterId: f.tag.id,
      limit: 2,
    });
    await expect(
      f.reads.listTagAssignments({
        ...f.input,
        tagId: f.tag.id,
        query: { after: page.nextCursor },
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
    const assignments = await f.reads.listTagAssignments({
      ...f.input,
      tagId: f.tag.id,
      query: {},
    });
    await expect(
      f.reads.listTagAssignments({
        ...f.input,
        tagId: randomUUID(),
        query: { after: assignments.nextCursor },
      }),
    ).rejects.toBeInstanceOf(InvalidWorkflowCursorError);
  });

  it.each(['viewer', 'builder'] as const)(
    'allows %s vocabulary reads but fences administrative assignment discovery',
    async (role) => {
      const f = fixture(role);
      await f.reads.listTags({ ...f.input, query: {} });
      await expect(
        f.reads.listTagAssignments({ ...f.input, tagId: f.tag.id, query: {} }),
      ).rejects.toMatchObject({ code: 'auth.forbidden' });
      expect(f.tags.listTagAssignments).not.toHaveBeenCalled();
    },
  );

  it('projects metadata alone without invoking the compatible template-origin owner', async () => {
    const f = fixture();
    expect(
      await f.reads.get({
        ...f.input,
        workflowId: f.item.workflow.id,
        query: { include: 'organization' },
      }),
    ).toMatchObject({ organization: f.item.organization });
    expect(f.origin.getWorkflowWithTemplateOrigin).not.toHaveBeenCalled();
    expect(
      await f.reads.get({
        ...f.input,
        workflowId: f.item.workflow.id,
        query: { include: 'templateOrigin,organization' },
      }),
    ).toMatchObject({
      templateOrigin: null,
      organization: f.item.organization,
    });
  });

  it('does not fabricate origin-null when the compatible reader is missing or denies visibility', async () => {
    const f = fixture();
    const reads = new WorkflowOrganizationReadsUseCase(
      f.reader,
      f.tags,
      f.authorization,
    );
    const input = {
      ...f.input,
      workflowId: f.item.workflow.id,
      query: { include: 'templateOrigin,organization' },
    };
    await expect(reads.get(input)).rejects.toBeInstanceOf(
      WorkflowTemplateOriginUnavailableError,
    );
    f.origin.getWorkflowWithTemplateOrigin.mockResolvedValue(null);
    await expect(f.reads.get(input)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
    f.reader.getWorkflow.mockResolvedValue(null);
    await expect(
      f.reads.get({ ...input, query: { include: 'organization' } }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it.each([
    { actorId: randomUUID() },
    { favoritesOnly: 'false' },
    { include: 'organization,templateOrigin' },
    { query: '表'.repeat(43) },
  ])(
    'rejects invalid/extra transport fields before reading: %j',
    async (query) => {
      const f = fixture();
      await expect(f.reads.list({ ...f.input, query })).rejects.toBeInstanceOf(
        z.ZodError,
      );
      expect(f.reader.listWorkflows).not.toHaveBeenCalled();
    },
  );

  it('rejects private extra response properties and propagates unexpected database failures', async () => {
    const f = fixture();
    f.reader.listWorkflows.mockResolvedValue({
      items: [
        {
          ...f.item,
          organization: { ...f.item.organization, generation: 'private' },
        },
      ],
      nextCursor: null,
    });
    await expect(
      f.reads.list({ ...f.input, query: { include: 'organization' } }),
    ).rejects.toBeInstanceOf(z.ZodError);
    const failure = new Error('unexpected database failure');
    f.reader.listWorkflows.mockRejectedValue(failure);
    await expect(f.reads.list({ ...f.input, query: {} })).rejects.toBe(failure);
  });

  it('does not read for an aborted operation or publish after a late abort', async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(
      f.reads.list({ ...f.input, signal: controller.signal, query: {} }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(f.reader.listWorkflows).not.toHaveBeenCalled();
    const late = new AbortController();
    f.reader.listWorkflows.mockImplementation(() => {
      late.abort();
      return Promise.resolve({ items: [f.item], nextCursor: null });
    });
    await expect(
      f.reads.list({ ...f.input, signal: late.signal, query: {} }),
    ).rejects.toHaveProperty('name', 'AbortError');
  });
});
