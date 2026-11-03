import type {
  workflowFavoriteRequestSchema,
  workflowTagCreateRequestSchema,
  workflowTagDeleteRequestSchema,
  workflowTagRenameRequestSchema,
  workflowTagReplaceRequestSchema,
} from '@pertexo/contracts';
import {
  workflowFavoriteResponseSchema,
  workflowTagCreateResponseSchema,
  workflowTagDeleteResponseSchema,
  workflowTagRenameResponseSchema,
  workflowTagReplaceResponseSchema,
} from '@pertexo/contracts';
import type {
  WorkflowFavoriteStore,
  WorkflowTagStore,
} from '@pertexo/core/authoring';
import type { z } from 'zod';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from './authority.js';

type CommandInput<Request = unknown> = WorkflowOrganizationInput &
  Readonly<{ request: Request; idempotencyKey: string }>;
type TagInput<Request = unknown> = CommandInput<Request> &
  Readonly<{ tagId: string }>;
type WorkflowInput<Request = unknown> = CommandInput<Request> &
  Readonly<{ workflowId: string }>;

/** Transport validation and role fences; persistence owns transactional authority. */
export class WorkflowOrganizationCommandsUseCase {
  public constructor(
    private readonly tags: WorkflowTagStore,
    private readonly favorites: WorkflowFavoriteStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async createTag(
    input: CommandInput<z.output<typeof workflowTagCreateRequestSchema>>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const request = input.request;
    const result = await this.tags.createTag({
      ...this.command(input),
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagCreateResponseSchema.parse(result);
  }

  public async renameTag(
    input: TagInput<z.output<typeof workflowTagRenameRequestSchema>>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const request = input.request;
    const result = await this.tags.renameTag({
      ...this.command(input),
      tagId: input.tagId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagRenameResponseSchema.parse(result);
  }

  public async deleteTag(
    input: TagInput<z.output<typeof workflowTagDeleteRequestSchema>>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin');
    const request = input.request;
    const result = await this.tags.deleteTag({
      ...this.command(input),
      tagId: input.tagId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagDeleteResponseSchema.parse(result);
  }

  public async replaceTags(
    input: WorkflowInput<z.output<typeof workflowTagReplaceRequestSchema>>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'editor');
    const request = input.request;
    const result = await this.tags.replaceTags({
      ...this.command(input),
      workflowId: input.workflowId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowTagReplaceResponseSchema.parse(result);
  }

  public async setFavorite(
    input: WorkflowOrganizationInput &
      Readonly<{
        request: z.output<typeof workflowFavoriteRequestSchema>;
        workflowId: string;
      }>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read');
    const request = input.request;
    input.signal?.throwIfAborted();
    const result = await this.favorites.setFavorite({
      ...workflowOrganizationContext(input),
      workflowId: input.workflowId,
      favorite: request.favorite,
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
