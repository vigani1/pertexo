import { credentialAllowsCapability } from '../../authorization/credentials.js';
import type {
  workflowGetQuerySchema,
  workflowOrganizationListQuerySchema,
  workflowTagListQuerySchema,
} from '@pertexo/contracts';
import {
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowTagAssignmentsResponseSchema,
  workflowTagListResponseSchema,
} from '@pertexo/contracts';
import {
  WorkflowNotFoundError,
  WorkflowTemplateOriginUnavailableError,
  type WorkflowOrganizationReadStore,
  type WorkflowTagStore,
} from '@pertexo/core/authoring';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import { parseRequestInput } from '../../platform/http/request-input.js';
import {
  serializeWorkflowList,
  serializeWorkflowSummary,
} from '../http/serializers.js';
import type { WorkflowAuthoringPersistence } from '../ports.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from './authority.js';
import {
  decodeOrganizationPageCursor,
  decodeWorkflowOrganizationCursor,
  encodeOrganizationPageCursor,
  encodeWorkflowOrganizationCursor,
} from './cursors.js';

type QueryInput<Request = unknown> = WorkflowOrganizationInput &
  Readonly<{ query: Request }>;

/** Owns normalized organization filters and purpose-bound continuations. */
export class WorkflowOrganizationReadsUseCase {
  public constructor(
    private readonly reader: Pick<
      WorkflowOrganizationReadStore,
      'getWorkflow' | 'listWorkflows'
    >,
    private readonly tags: Pick<
      WorkflowTagStore,
      'listTags' | 'listTagAssignments'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly origin: Pick<
      WorkflowAuthoringPersistence,
      'getWorkflowWithTemplateOrigin'
    > = {},
  ) {}

  public async list(
    input: QueryInput<z.output<typeof workflowOrganizationListQuerySchema>>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read', {
      reading: true,
    });
    const query = input.query;
    const context = workflowOrganizationContext(input);
    const filters = {
      ...(query.query === undefined ? {} : { query: query.query }),
      view: query.view ?? 'all',
      ...(query.tagId === undefined ? {} : { tagId: query.tagId }),
      ...(query.folderId === undefined ? {} : { folderId: query.folderId }),
      favoritesOnly: query.favoritesOnly === 'true',
    };
    const cursorContext = {
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      order: query.order ?? 'created_asc',
      filterHash: createHash('sha256')
        .update(
          JSON.stringify({
            query: filters.query ?? null,
            view: filters.view,
            tagId: filters.tagId ?? null,
            folderId: filters.folderId ?? null,
            favoritesOnly: filters.favoritesOnly,
            include: query.include ?? null,
          }),
        )
        .digest('hex'),
    };
    const page = await this.reader.listWorkflows({
      ...context,
      ...filters,
      includeListSummary: query.include?.includes('listSummary') ?? false,
      order: cursorContext.order,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined
        ? {}
        : {
            after: decodeWorkflowOrganizationCursor(query.after, cursorContext),
          }),
    });
    input.signal?.throwIfAborted();
    const nextCursor =
      page.nextCursor === null
        ? null
        : encodeWorkflowOrganizationCursor(cursorContext, page.nextCursor);
    const projection = query.include?.includes('listSummary')
      ? { recentRuns: credentialAllowsCapability(input.actor, 'run:read') }
      : undefined;
    if (!query.include?.includes('organization'))
      return serializeWorkflowList(
        page.items.map((item) => item.workflow),
        nextCursor,
        projection,
      );
    return workflowOrganizationListResponseSchema.parse({
      items: page.items.map((item) => ({
        workflow: serializeWorkflowSummary(item.workflow, projection).workflow,
        organization: item.organization,
      })),
      nextCursor,
    });
  }

  public async get(
    input: QueryInput<z.output<typeof workflowGetQuerySchema>> &
      Readonly<{ workflowId: string }>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read', {
      reading: true,
    });
    const query = input.query;
    if (
      query.include !== 'organization' &&
      query.include !== 'templateOrigin,organization'
    )
      throw new TypeError(
        'Organization reader requires an organization projection',
      );
    const context = workflowOrganizationContext(input);
    const projection = await this.reader.getWorkflow({
      ...context,
      workflowId: input.workflowId,
    });
    input.signal?.throwIfAborted();
    if (projection === null)
      throw new WorkflowNotFoundError('Workflow is not visible');
    const body = {
      workflow: serializeWorkflowSummary(projection.workflow).workflow,
      organization: projection.organization,
    };
    if (query.include === 'organization')
      return parseRequestInput(
        workflowOrganizationProjectionResponseSchema,
        body,
      );
    // The origin reader owns visibility and validates the requested projection.
    if (this.origin.getWorkflowWithTemplateOrigin === undefined)
      throw new WorkflowTemplateOriginUnavailableError();
    input.signal?.throwIfAborted();
    const source = await this.origin.getWorkflowWithTemplateOrigin(
      context.workspaceId,
      input.workflowId,
      context.actorId,
    );
    input.signal?.throwIfAborted();
    if (source === null)
      throw new WorkflowNotFoundError('Workflow is not visible');
    return workflowCombinedOrganizationProjectionResponseSchema.parse({
      ...body,
      templateOrigin: source.templateOrigin,
    });
  }

  public async listTags(
    input: QueryInput<z.output<typeof workflowTagListQuerySchema>>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read', {
      reading: true,
    });
    const query = input.query;
    const context = workflowOrganizationContext(input);
    const cursorContext = {
      purpose: 'tags' as const,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      selectedTagId: null,
    };
    const page = await this.tags.listTags({
      ...context,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined
        ? {}
        : {
            afterId: decodeOrganizationPageCursor(query.after, cursorContext),
          }),
    });
    input.signal?.throwIfAborted();
    return workflowTagListResponseSchema.parse({
      items: page.items,
      nextCursor:
        page.nextId === null
          ? null
          : encodeOrganizationPageCursor(cursorContext, page.nextId),
    });
  }

  public async listTagAssignments(
    input: QueryInput<z.output<typeof workflowTagListQuerySchema>> &
      Readonly<{ tagId: string }>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin', {
      reading: true,
    });
    const query = input.query;
    const context = workflowOrganizationContext(input);
    const cursorContext = {
      purpose: 'tag-assignments' as const,
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      selectedTagId: input.tagId,
    };
    const page = await this.tags.listTagAssignments({
      ...context,
      tagId: input.tagId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined
        ? {}
        : {
            afterId: decodeOrganizationPageCursor(query.after, cursorContext),
          }),
    });
    input.signal?.throwIfAborted();
    return workflowTagAssignmentsResponseSchema.parse({
      items: page.items,
      nextCursor:
        page.nextId === null
          ? null
          : encodeOrganizationPageCursor(cursorContext, page.nextId),
    });
  }
}
