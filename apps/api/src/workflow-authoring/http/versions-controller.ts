import { workflowParams, requestContext } from './context.js';

import { AutomationAuthenticationGuard } from '../../authentication/automation/guard.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';

import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';

import { workflowVersionRestoreParamsSchema } from '@pertexo/contracts';

import { RestoreWorkflowVersionUseCase } from '../commands/restore-version.js';
import { WorkflowReadGuard, WorkflowUpdateGuard } from './guards.js';
import { parseStrongIfMatch } from './preconditions.js';
import { ListWorkflowVersionsUseCase } from '../use-cases.js';
import {
  workflowVersionsQuerySchema,
  type WorkflowAuthoringRequest,
  type WorkflowResponse,
} from '../types.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';
@UseInterceptors(domainErrors(authoringFailure))
@Controller('v1/workspaces/:workspaceId/workflows')
@RateLimit('authenticated_read')
export class WorkflowVersionsController {
  public constructor(
    private readonly listVersions: ListWorkflowVersionsUseCase,
    private readonly restoreWorkflowVersion: RestoreWorkflowVersionUseCase,
  ) {}
  @Post(':workflowId/versions/:versionId/restore')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async restoreVersion(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = workflowVersionRestoreParamsSchema.parse(params);
    const context = requestContext(request, route.workspaceId);
    const result = await this.restoreWorkflowVersion.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      versionId: route.versionId,
      representationTag: parseStrongIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      ),
      request: body,
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }
  @Get(':workflowId/versions')
  @UseGuards(AutomationAuthenticationGuard, WorkflowReadGuard)
  public async versions(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = workflowParams(params);
    const input = workflowVersionsQuerySchema.parse(query ?? {});
    const context = requestContext(request, route.workspaceId);
    return this.listVersions.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
}
