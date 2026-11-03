import type {
  folderSharingRequestSchema,
  sharingPrincipalsQuerySchema,
  workflowFolderCreateRequestSchema,
  workflowFolderDeleteRequestSchema,
  workflowFolderListQuerySchema,
  workflowFolderMoveRequestSchema,
  workflowFolderPlacementRequestSchema,
  workflowFolderRenameRequestSchema,
  workflowMoveReviewRequestSchema,
} from '@pertexo/contracts';
import {
  folderSharingResponseSchema,
  sharingPrincipalsResponseSchema,
  workflowFolderCreateResponseSchema,
  workflowFolderDeleteResponseSchema,
  workflowFolderListResponseSchema,
  workflowFolderMoveResponseSchema,
  workflowFolderPlacementResponseSchema,
  workflowFolderRenameResponseSchema,
  workflowMoveReviewResponseSchema,
} from '@pertexo/contracts';
import type { WorkflowFolderStore } from '@pertexo/core/authoring';
import type { z } from 'zod';
import type { WorkspaceAuthorizationSource } from '../../../authorization/index.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from '../authority.js';

type Command<Request = unknown> = WorkflowOrganizationInput &
  Readonly<{ request: Request; idempotencyKey: string }>;
type FolderCommand<Request = unknown> = Command<Request> &
  Readonly<{ folderId: string }>;

/** Folder metadata does not grant authority or change workflow lifecycle. */
export class WorkflowFoldersUseCase {
  public constructor(
    private readonly folders: WorkflowFolderStore,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async sharingPrincipals(
    input: WorkflowOrganizationInput & {
      query: z.output<typeof sharingPrincipalsQuerySchema>;
    },
  ) {
    const query = input.query;
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

  public async replaceSharing(
    input: FolderCommand<z.output<typeof folderSharingRequestSchema>>,
  ) {
    const request = input.request;
    const context = await this.command(input, 'admin');
    const { replayed, ...sharing } = await this.folders.replaceSharing({
      ...context,
      folderId: input.folderId,
      request,
    });
    return { ...folderSharingResponseSchema.parse(sharing), replayed };
  }

  public async reviewMove(
    input: WorkflowOrganizationInput & {
      request: z.output<typeof workflowMoveReviewRequestSchema>;
    },
  ) {
    const request = input.request;
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
    input: WorkflowOrganizationInput &
      Readonly<{ query: z.output<typeof workflowFolderListQuerySchema> }>,
  ) {
    await authorizeWorkflowOrganization(input, this.authorization, 'read', {
      reading: true,
    });
    const result = await this.folders.listFolders(
      workflowOrganizationContext(input),
    );
    input.signal?.throwIfAborted();
    return workflowFolderListResponseSchema.parse(result);
  }

  public async create(
    input: Command<z.output<typeof workflowFolderCreateRequestSchema>>,
  ) {
    const request = input.request;
    const context = await this.command(input, 'admin');
    const result = await this.folders.createFolder({ ...context, ...request });
    input.signal?.throwIfAborted();
    return workflowFolderCreateResponseSchema.parse(result);
  }

  public async rename(
    input: FolderCommand<z.output<typeof workflowFolderRenameRequestSchema>>,
  ) {
    const request = input.request;
    const context = await this.command(input, 'admin');
    const result = await this.folders.renameFolder({
      ...context,
      folderId: input.folderId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderRenameResponseSchema.parse(result);
  }

  public async move(
    input: FolderCommand<z.output<typeof workflowFolderMoveRequestSchema>>,
  ) {
    const request = input.request;
    const context = await this.command(input, 'admin');
    const result = await this.folders.moveFolder({
      ...context,
      folderId: input.folderId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderMoveResponseSchema.parse(result);
  }

  public async delete(
    input: FolderCommand<z.output<typeof workflowFolderDeleteRequestSchema>>,
  ) {
    const request = input.request;
    const context = await this.command(input, 'admin');
    const result = await this.folders.deleteFolder({
      ...context,
      folderId: input.folderId,
      ...request,
    });
    input.signal?.throwIfAborted();
    return workflowFolderDeleteResponseSchema.parse(result);
  }

  public async place(
    input: Command<z.output<typeof workflowFolderPlacementRequestSchema>> &
      Readonly<{ workflowId: string }>,
  ) {
    const request = input.request;
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
