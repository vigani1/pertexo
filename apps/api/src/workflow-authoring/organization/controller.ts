import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  workflowTagWorkspaceParamsSchema,
  workflowTagParamsSchema,
  workflowIdParamSchema,
} from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../workspaces/index.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import {
  WorkflowParticipantGuard,
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from '../http/guards.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { WorkflowOrganizationCommandsUseCase } from './commands.js';
import { WorkflowOrganizationReadsUseCase } from './reads.js';
import {
  withWorkflowOrganizationRequest,
  withWorkflowOrganizationCommand,
} from './http.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowOrganizationController {
  public constructor(
    private readonly commands: WorkflowOrganizationCommandsUseCase,
    private readonly reads: WorkflowOrganizationReadsUseCase,
  ) {}

  @Get('workflow-tags')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public listTags(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workflowTagWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.reads.listTags({
        ...input,
        query: query ?? {},
      }),
    );
  }

  @Post('workflow-tags')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public createTag(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowTagWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.commands.createTag({
        ...input,
        request: body,
      }),
    );
  }

  @Post('workflow-tags/:tagId/rename')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public renameTag(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, tagId } = workflowTagParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.commands.renameTag({
        ...input,
        tagId,
        request: body,
      }),
    );
  }

  @Post('workflow-tags/:tagId/delete')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public deleteTag(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, tagId } = workflowTagParamsSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.commands.deleteTag({
        ...input,
        tagId,
        request: body,
      }),
    );
  }

  @Get('workflow-tags/:tagId/workflows')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public assignments(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId, tagId } = workflowTagParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.reads.listTagAssignments({
        ...input,
        tagId,
        query: query ?? {},
      }),
    );
  }

  @Post('workflows/:workflowId/tags')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public replaceTags(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
    return withWorkflowOrganizationCommand(request, workspaceId, (input) =>
      this.commands.replaceTags({
        ...input,
        workflowId,
        request: body,
      }),
    );
  }

  @Put('workflows/:workflowId/favorite')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    CsrfProtectionGuard,
  )
  public favorite(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.commands.setFavorite({
        ...input,
        workflowId,
        request: body,
      }),
    );
  }
}
