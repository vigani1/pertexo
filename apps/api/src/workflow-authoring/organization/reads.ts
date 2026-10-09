import { createHash } from 'node:crypto';
import {
  workflowOrganizationListQuerySchema,
  workflowOrganizationListResponseSchema,
  workflowOrganizationProjectionResponseSchema,
  workflowCombinedOrganizationProjectionResponseSchema,
  workflowGetQuerySchema,
  workflowTagListQuerySchema,
  workflowTagListResponseSchema,
  workflowTagAssignmentsResponseSchema,
} from '@pertexo/contracts';
import {
  WorkflowNotFoundError,
  WorkflowTemplateOriginUnavailableError,
  type WorkflowOrganizationReadDatabase,
  type WorkflowTagDatabase,
} from '@pertexo/database/authoring';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import type { WorkflowAuthoringPersistence } from '../ports.js';
import type { WorkflowOrganizationCursorCodec } from './cursors/organization.js';
import type { WorkflowOrganizationPageCursorCodec } from './cursors/page.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from './authority.js';
import {
  serializeWorkflowList,
  serializeWorkflowSummary,
} from '../http/serializers.js';

type QueryInput = WorkflowOrganizationInput & Readonly<{ query: unknown }>;

/** Owns normalized filter identity and purpose-bound continuations; defaults
 * still belong to the unchanged legacy use cases, not this opt-in reader. */
export class WorkflowOrganizationReadsUseCase {
  public constructor(
    private readonly reader: Pick<
      WorkflowOrganizationReadDatabase,
      'getWorkflow' | 'listWorkflows'
    >,
    private readonly tags: Pick<
      WorkflowTagDatabase,
      'listTags' | 'listTagAssignments'
    >,
    private readonly cursors: Readonly<{
      workflows: WorkflowOrganizationCursorCodec;
      pages: WorkflowOrganizationPageCursorCodec;
    }>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly origin: Pick<
      WorkflowAuthoringPersistence,
      'getWorkflowWithTemplateOrigin'
    > = {},
  ) {}

  public async list(input: QueryInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read');
    const query = workflowOrganizationListQuerySchema.parse(input.query);
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
      order: cursorContext.order,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.after === undefined
        ? {}
        : { after: this.cursors.workflows.decode(query.after, cursorContext) }),
    });
    input.signal?.throwIfAborted();
    const nextCursor =
      page.nextCursor === null
        ? null
        : this.cursors.workflows.encode(cursorContext, page.nextCursor);
    if (query.include === undefined)
      return serializeWorkflowList(
        page.items.map((item) => item.workflow),
        nextCursor,
      );
    return workflowOrganizationListResponseSchema.parse({
      items: page.items.map((item) => ({
        workflow: serializeWorkflowSummary(item.workflow).workflow,
        organization: item.organization,
      })),
      nextCursor,
    });
  }

  public async get(input: QueryInput & Readonly<{ workflowId: string }>) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read');
    const query = workflowGetQuerySchema.parse(input.query);
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
      return workflowOrganizationProjectionResponseSchema.parse(body);
    // Origin remains owned by the existing compatible reader and its rollout gate;
    // never bypass validation with a raw join or turn unsupported into null.
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

  public async listTags(input: QueryInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read');
    const query = workflowTagListQuerySchema.parse(input.query);
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
            afterId: this.cursors.pages.decode(query.after, cursorContext).id,
          }),
    });
    input.signal?.throwIfAborted();
    return workflowTagListResponseSchema.parse({
      items: page.items,
      nextCursor:
        page.nextId === null
          ? null
          : this.cursors.pages.encode(cursorContext, { id: page.nextId }),
    });
  }

  public async listTagAssignments(
    input: QueryInput & Readonly<{ tagId: string }>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const query = workflowTagListQuerySchema.parse(input.query);
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
            afterId: this.cursors.pages.decode(query.after, cursorContext).id,
          }),
    });
    input.signal?.throwIfAborted();
    return workflowTagAssignmentsResponseSchema.parse({
      items: page.items,
      nextCursor:
        page.nextId === null
          ? null
          : this.cursors.pages.encode(cursorContext, { id: page.nextId }),
    });
  }
}
