import { requestIdempotencyKey } from '../../../platform/http/index.js';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  workflowFolderWorkspaceParamsSchema,
  workflowFolderParamsSchema,
  workflowIdParamSchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../../workspaces/index.js';
import { RateLimit } from '../../../platform/rate-limit/metadata.js';
import { WorkflowReadGuard } from '../../http/guards.js';
import type { WorkflowAuthoringRequest } from '../../types.js';
import { WorkflowFoldersUseCase } from './use-case.js';
import { withWorkflowOrganizationRequest } from '../http.js';

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowFoldersController {
  public constructor(private readonly folders: WorkflowFoldersUseCase) {}

  @Get('workflow-folders')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public list(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workflowFolderWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.list({
        ...input,
        query: query ?? {},
      }),
    );
  }

  @Post('workflow-folders')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public create(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowFolderWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.create({
        ...input,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Post('workflow-folders/:folderId/rename')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public rename(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.rename({
        ...input,
        folderId,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Post('workflow-folders/:folderId/move')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public move(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.move({
        ...input,
        folderId,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Post('workflow-folders/:folderId/delete')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public delete(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.delete({
        ...input,
        folderId,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Post('workflows/:workflowId/folder')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public place(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.place({
        ...input,
        workflowId,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }
}

function commandKey(request: WorkflowAuthoringRequest) {
  return requestIdempotencyKey(request.headers);
}
