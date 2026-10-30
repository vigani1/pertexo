import {
  sharingPrincipalsQuerySchema,
  sharingPrincipalsResponseSchema,
  folderSharingRequestSchema,
  folderSharingResponseSchema,
  workflowMoveReviewRequestSchema,
  workflowMoveReviewResponseSchema,
  workflowFolderListQuerySchema,
  workflowFolderListResponseSchema,
  workflowFolderCreateRequestSchema,
  workflowFolderCreateResponseSchema,
  workflowFolderRenameRequestSchema,
  workflowFolderRenameResponseSchema,
  workflowFolderMoveRequestSchema,
  workflowFolderMoveResponseSchema,
  workflowFolderDeleteRequestSchema,
  workflowFolderDeleteResponseSchema,
  workflowFolderPlacementRequestSchema,
  workflowFolderPlacementResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowFolderDatabase } from '@pertexo/database/authoring';
import type { WorkspaceAuthorizationSource } from '../../../authorization/index.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from '../authority.js';
import { parseRequestBody } from '../../../platform/http/index.js';

type Command = WorkflowOrganizationInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;
type FolderCommand = Command & Readonly<{ folderId: string }>;

/** Folder metadata does not grant authority or change workflow lifecycle. */
export class WorkflowFoldersUseCase {
  public constructor(
    private readonly folders: WorkflowFolderDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async sharingPrincipals(
    input: WorkflowOrganizationInput & { query: unknown },
  ) {
    const query = sharingPrincipalsQuerySchema.parse(input.query);
    await authorizeWorkflowOrganization(input, this.authorization, 'admin', {
      reading: true,
    });
    return sharingPrincipalsResponseSchema.parse(
      await this.folders.sharingPrincipals({
        ...workflowOrganizationContext(input),
        query,
      }),
    );
  }

  public async readSharing(
    input: WorkflowOrganizationInput & { folderId: string },
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'admin', {
      reading: true,
    });
    return folderSharingResponseSchema.parse(
      await this.folders.readSharing({
        ...workflowOrganizationContext(input),
        folderId: input.folderId,
      }),
    );
  }

  public async replaceSharing(input: FolderCommand) {
    const request = parseRequestBody(folderSharingRequestSchema, input.request);
    const context = await this.command(input, 'admin');
    const { replayed, ...sharing } = await this.folders.replaceSharing({
      ...context,
      folderId: input.folderId,
      request,
    });
    return { ...folderSharingResponseSchema.parse(sharing), replayed };
  }

  public async reviewMove(
    input: WorkflowOrganizationInput & { request: unknown },
  ) {
    const request = parseRequestBody(
      workflowMoveReviewRequestSchema,
      input.request,
    );
    await authorizeWorkflowOrganization(input, this.authorization, 'editor', {
      fresh: true,
    });
    return workflowMoveReviewResponseSchema.parse(
      await this.folders.reviewMove({
        ...workflowOrganizationContext(input),
        request,
      }),
    );
  }

  public async list(
    input: WorkflowOrganizationInput & Readonly<{ query: unknown }>,
  ) {
    workflowFolderListQuerySchema.parse(input.query);
    await authorizeWorkflowOrganization(input, this.authorization, 'read', {
      reading: true,
    });
    const result = await this.folders.listFolders(
      workflowOrganizationContext(input),
    );
    input.signal?.throwIfAborted();
    return workflowFolderListResponseSchema.parse(result);
  }

  public async create(input: Command) {
    const request = parseRequestBody(
      workflowFolderCreateRequestSchema,
      input.request,
    );
    const context = await this.command(input, 'admin');
    const result = await this.folders.createFolder({ ...context, ...request });
    input.signal?.throwIfAborted();
    return workflowFolderCreateResponseSchema.parse(result);
  }

  public async rename(input: FolderCommand) {
    const request = parseRequestBody(
      workflowFolderRenameRequestSchema,
      input.request,
    );
    const context = await this.command(input, 'admin');
    const result = await this.folders.renameFolder({
      ...context,
      folderId: input.folderId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderRenameResponseSchema.parse(result);
  }

  public async move(input: FolderCommand) {
    const request = parseRequestBody(
      workflowFolderMoveRequestSchema,
      input.request,
    );
    const context = await this.command(input, 'admin');
    const result = await this.folders.moveFolder({
      ...context,
      folderId: input.folderId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderMoveResponseSchema.parse(result);
  }

  public async delete(input: FolderCommand) {
    const request = parseRequestBody(
      workflowFolderDeleteRequestSchema,
      input.request,
    );
    const context = await this.command(input, 'admin');
    const result = await this.folders.deleteFolder({
      ...context,
      folderId: input.folderId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderDeleteResponseSchema.parse(result);
  }

  public async place(input: Command & Readonly<{ workflowId: string }>) {
    const request = parseRequestBody(
      workflowFolderPlacementRequestSchema,
      input.request,
    );
    // Read guard at HTTP; this role fence permits archived admin placement.
    // Persistence owns the transactional lifecycle-specific editor fence.
    const context = await this.command(input, 'editor');
    const result = await this.folders.placeWorkflow({
      ...context,
      workflowId: input.workflowId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderPlacementResponseSchema.parse(result);
  }

  private async command(input: Command, role: 'admin' | 'editor') {
    await authorizeWorkflowOrganization(input, this.authorization, role, {
      fresh: role === 'editor',
    });
    input.signal?.throwIfAborted();
    return {
      ...workflowOrganizationContext(input),
      idempotencyKey: input.idempotencyKey,
    };
  }
}
