import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  workflowRecoveryRequestSchema,
  workflowRunParamsSchema,
} from '@pertexo/contracts';
import { requestIdempotencyKey } from '../../platform/http/index.js';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import {
  authenticatedRequestIdentifiers,
  optionalAuthorizedWorkspace,
} from '../../workspaces/request/authenticated-context.js';
import {
  actorFrom,
  type WorkflowRunsRequest,
} from '../http/request-context.js';
import { WorkflowRunReplayGuard } from '../http/guards.js';
import { GetRunRecoveryUseCase, RecoverRunUseCase } from './use-cases.js';

@Controller('v1/workspaces/:workspaceId/runs/:runId')
@UseGuards(SessionAuthenticationGuard, WorkflowRunReplayGuard)
export class RunRecoveryController {
  public constructor(
    private readonly preview: GetRunRecoveryUseCase,
    private readonly recover: RecoverRunUseCase,
  ) {}
  @Get('recovery')
  @RateLimit('authenticated_read')
  public async get(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    return this.preview.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
    });
  }
  @Post('recover')
  @HttpCode(202)
  @RateLimit('run_admission')
  @UseGuards(CsrfProtectionGuard)
  public async start(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    const input = workflowRecoveryRequestSchema.parse(body);
    const traceparent = singleRequestHeader(request.headers, 'traceparent');
    return this.recover.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
      workflowVersionId: input.workflowVersionId,
      nodeRunId: input.nodeRunId,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...(input.acknowledgePossibleEffects === undefined
        ? {}
        : { acknowledgePossibleEffects: input.acknowledgePossibleEffects }),
      idempotencyKey: requestIdempotencyKey(request.headers),
      ...authenticatedRequestIdentifiers(request),
      ...(traceparent === undefined ? {} : { traceparent }),
    });
  }
}
