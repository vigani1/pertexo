import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
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
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { WorkflowReadGuard, WorkflowUpdateGuard } from '../http/guards.js';
import { parseIdempotencyKey } from '../http/preconditions.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { WorkflowOrganizationCommandsUseCase } from './commands.js';
import { WorkflowOrganizationReadsUseCase } from './reads.js';
import {
  requireWorkflowOrganization,
  withWorkflowOrganizationRequest,
} from './http.js';

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowOrganizationController {
  public constructor(
    @Optional() private readonly commands?: WorkflowOrganizationCommandsUseCase,
    @Optional() private readonly reads?: WorkflowOrganizationReadsUseCase,
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
      requireWorkflowOrganization(this.reads).listTags({
        ...input,
        query: query ?? {},
      }),
    );
  }

  @Post('workflow-tags')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public createTag(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workflowTagWorkspaceParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      requireWorkflowOrganization(this.commands).createTag({
        ...input,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Post('workflow-tags/:tagId/rename')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public renameTag(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, tagId } = workflowTagParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      requireWorkflowOrganization(this.commands).renameTag({
        ...input,
        tagId,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Post('workflow-tags/:tagId/delete')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public deleteTag(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, tagId } = workflowTagParamsSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      requireWorkflowOrganization(this.commands).deleteTag({
        ...input,
        tagId,
        request: body,
        idempotencyKey: commandKey(request),
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
      requireWorkflowOrganization(this.reads).listTagAssignments({
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
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      requireWorkflowOrganization(this.commands).replaceTags({
        ...input,
        workflowId,
        request: body,
        idempotencyKey: commandKey(request),
      }),
    );
  }

  @Put('workflows/:workflowId/favorite')
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public favorite(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      requireWorkflowOrganization(this.commands).setFavorite({
        ...input,
        workflowId,
        request: body,
      }),
    );
  }
}
function commandKey(request: WorkflowAuthoringRequest) {
  return parseIdempotencyKey(
    requestHeaderValue(request.headers, 'idempotency-key'),
  );
}
