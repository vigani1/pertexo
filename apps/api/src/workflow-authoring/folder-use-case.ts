import {
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
} from '@pertexo/contracts/schemas/workflow-authoring';
import type { WorkflowFolderDatabase } from '@pertexo/database/api';
import type { WorkspaceAuthorizationSource } from '../workspaces/index.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from './organization-authority.js';

type Command = WorkflowOrganizationInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;
type FolderCommand = Command & Readonly<{ folderId: string }>;

/** Folder metadata does not grant authority or change workflow lifecycle. */
export class WorkflowFoldersUseCase {
  public constructor(
    private readonly folders: WorkflowFolderDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async list(
    input: WorkflowOrganizationInput & Readonly<{ query: unknown }>,
  ) {
    workflowFolderListQuerySchema.parse(input.query);
    await authorizeWorkflowOrganization(input, this.authorization, 'read');
    const result = await this.folders.listFolders(
      workflowOrganizationContext(input),
    );
    input.signal?.throwIfAborted();
    return workflowFolderListResponseSchema.parse(result);
  }

  public async create(input: Command) {
    const request = workflowFolderCreateRequestSchema.parse(input.request);
    const context = await this.command(input, 'admin');
    const result = await this.folders.createFolder({ ...context, ...request });
    input.signal?.throwIfAborted();
    return workflowFolderCreateResponseSchema.parse(result);
  }

  public async rename(input: FolderCommand) {
    const request = workflowFolderRenameRequestSchema.parse(input.request);
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
    const request = workflowFolderMoveRequestSchema.parse(input.request);
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
    const request = workflowFolderDeleteRequestSchema.parse(input.request);
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
    const request = workflowFolderPlacementRequestSchema.parse(input.request);
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
    await authorizeWorkflowOrganization(
      input,
      this.authorization,
      role,
      role === 'editor',
    );
    input.signal?.throwIfAborted();
    return {
      ...workflowOrganizationContext(input),
      idempotencyKey: input.idempotencyKey,
    };
  }
}
