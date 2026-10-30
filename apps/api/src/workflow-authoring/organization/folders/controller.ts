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
  UseInterceptors,
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
import {
  WorkflowParticipantGuard,
  WorkflowReadGuard,
} from '../../http/guards.js';
import type { WorkflowAuthoringRequest } from '../../types.js';
import { WorkflowFoldersUseCase } from './use-case.js';
import {
  withWorkflowOrganizationRequest,
  withWorkflowOrganizationCommand,
} from '../http.js';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../../problems/context/normalize.js';

@UseInterceptors(domainErrors(authoringFailure))
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

  @Get('resource-sharing-principals')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public sharingPrincipals(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workflowFolderWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.sharingPrincipals({ ...input, query }),
    );
  }

  @Get('workflow-folders/:folderId/sharing')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public readSharing(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.readSharing({ ...input, folderId }),
    );
  }

  @Post('workflow-folders/:folderId/sharing')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public replaceSharing(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.folders.replaceSharing({
        ...input,
        folderId,
        request: body,
      }),
    );
  }

  @Post('workflow-folders/review-move')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('authenticated_read')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public reviewMove(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowFolderWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.reviewMove({ ...input, request: body }),
    );
  }

  @Post('workflow-folders')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public create(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowFolderWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.folders.create({
        ...input,
        request: body,
      }),
    );
  }

  @Post('workflow-folders/:folderId/rename')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public rename(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.folders.rename({
        ...input,
        folderId,
        request: body,
      }),
    );
  }

  @Post('workflow-folders/:folderId/move')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public move(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.folders.move({
        ...input,
        folderId,
        request: body,
      }),
    );
  }

  @Post('workflow-folders/:folderId/delete')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public delete(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, folderId } = workflowFolderParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.folders.delete({
        ...input,
        folderId,
        request: body,
      }),
    );
  }

  @Post('workflows/:workflowId/folder')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public place(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.folders.place({
        ...input,
        workflowId,
        request: body,
      }),
    );
  }
}
