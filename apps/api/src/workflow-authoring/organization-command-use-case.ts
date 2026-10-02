import {
  workflowTagCreateRequestSchema,
  workflowTagCreateResponseSchema,
  workflowTagRenameRequestSchema,
  workflowTagRenameResponseSchema,
  workflowTagDeleteRequestSchema,
  workflowTagDeleteResponseSchema,
  workflowTagReplaceRequestSchema,
  workflowTagReplaceResponseSchema,
  workflowFavoriteRequestSchema,
  workflowFavoriteResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import type {
  WorkflowTagDatabase,
  WorkflowFavoriteDatabase,
} from '@pertexo/database/api';
import type { WorkspaceAuthorizationSource } from '../workspaces/index.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from './organization-authority.js';

type CommandInput = WorkflowOrganizationInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;
type TagInput = CommandInput & Readonly<{ tagId: string }>;
type WorkflowInput = CommandInput & Readonly<{ workflowId: string }>;

/** Transport validation and role fences; persistence owns transactional authority. */
export class WorkflowOrganizationCommandsUseCase {
  public constructor(
    private readonly tags: WorkflowTagDatabase,
    private readonly favorites: WorkflowFavoriteDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async createTag(input: CommandInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const request = workflowTagCreateRequestSchema.parse(input.request);
    const result = await this.tags.createTag({
      ...this.command(input),
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagCreateResponseSchema.parse(result);
  }

  public async renameTag(input: TagInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const request = workflowTagRenameRequestSchema.parse(input.request);
    const result = await this.tags.renameTag({
      ...this.command(input),
      tagId: input.tagId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagRenameResponseSchema.parse(result);
  }

  public async deleteTag(input: TagInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const request = workflowTagDeleteRequestSchema.parse(input.request);
    const result = await this.tags.deleteTag({
      ...this.command(input),
      tagId: input.tagId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagDeleteResponseSchema.parse(result);
  }

  public async replaceTags(input: WorkflowInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'editor');
    const request = workflowTagReplaceRequestSchema.parse(input.request);
    const result = await this.tags.replaceTags({
      ...this.command(input),
      workflowId: input.workflowId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagReplaceResponseSchema.parse(result);
  }

  public async setFavorite(input: WorkflowInput) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read');
    const request = workflowFavoriteRequestSchema.parse(input.request);
    const result = await this.favorites.setFavorite({
      ...this.command(input),
      workflowId: input.workflowId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFavoriteResponseSchema.parse(result);
  }

  private command(input: CommandInput) {
    input.signal?.throwIfAborted();
    return {
      ...workflowOrganizationContext(input),
      idempotencyKey: input.idempotencyKey,
    };
  }
}
