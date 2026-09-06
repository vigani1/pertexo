import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { applicationError } from '../platform/http/index.js';
import {
  requestHeaderValue,
  singleRequestHeader,
} from '../platform/http/request-headers.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { TransitionWorkflowLifecycleUseCase } from './lifecycle-use-case.js';
import { createActorContext } from '../workspaces/index.js';
import { throwWorkflowApplicationError } from './errors.js';
import {
  WorkflowCreateGuard,
  WorkflowPublishGuard,
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from './guards.js';
import { parseIdempotencyKey, parseStrongIfMatch } from './preconditions.js';
import {
  CreateWorkflowUseCase,
  GetWorkflowDraftUseCase,
  ListWorkflowVersionsUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from './use-cases.js';
import {
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListQuerySchema,
  workflowVersionsQuerySchema,
  type WorkflowAuthoringRequest,
  type WorkflowResponse,
} from './types.js';

const workflowWorkspaceParamSchema = workflowIdParamSchema
  .pick({ workspaceId: true })
  .strict()
  .readonly();

@Controller('v1/workspaces/:workspaceId/workflows')
@RateLimit('authenticated_read')
export class WorkflowAuthoringController {
  public constructor(
    private readonly listWorkflows: ListWorkflowsUseCase,
    private readonly createWorkflow: CreateWorkflowUseCase,
    private readonly getDraft: GetWorkflowDraftUseCase,
    private readonly saveDraft: SaveWorkflowDraftUseCase,
    private readonly validateDraft: ValidateWorkflowDraftUseCase,
    private readonly publishWorkflow: PublishWorkflowUseCase,
    private readonly listVersions: ListWorkflowVersionsUseCase,
    private readonly transitionLifecycle: TransitionWorkflowLifecycleUseCase,
  ) {}

  @Get()
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async list(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workspaceParams(params);
    const input = workflowListQuerySchema.parse(query ?? {});
    return this.listWorkflows.execute({
      actor: actorFrom(request, workspaceId),
      routeWorkspaceId: workspaceId,
      ...guardAuthorization(request),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }

  @Post()
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowCreateGuard,
    CsrfProtectionGuard,
  )
  public async create(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const { workspaceId } = workspaceParams(params);
    const result = await this.createWorkflow.execute({
      actor: actorFrom(request, workspaceId),
      routeWorkspaceId: workspaceId,
      ...guardAuthorization(request),
      request: body,
      idempotencyKey: parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      ),
      ...requestIdentifiers(request),
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }

  @Get(':workflowId/draft')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async draft(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = workflowParams(params);
    const result = await this.getDraft.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }

  @Put(':workflowId/draft')
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async save(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = workflowParams(params);
    const input = workflowDraftSaveRequestSchema.parse(body);
    const result = await this.saveDraft.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
      representationTag: parseStrongIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      ),
      graph: input.graph,
      ...requestIdentifiers(request),
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }

  @Post(':workflowId/validate')
  @RateLimit('workflow_compile')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public async validate(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    const route = workflowParams(params);
    return this.validateDraft.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
    });
  }

  @Post(':workflowId/publish')
  @RateLimit('workflow_compile')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public async publish(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    const route = workflowParams(params);
    return this.publishWorkflow.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
      representationTag: parseStrongIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      ),
      idempotencyKey: parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      ),
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }

  @Post(':workflowId/archive')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public archive(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycleCommand('archive', request, params, body);
  }

  @Post(':workflowId/restore')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public restore(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycleCommand('restore', request, params, body);
  }

  private lifecycleCommand(
    command: 'archive' | 'restore',
    request: WorkflowAuthoringRequest,
    params: unknown,
    body: unknown,
  ) {
    const route = workflowParams(params);
    return this.transitionLifecycle.execute({
      command,
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
      request: body,
      idempotencyKey: parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      ),
      ...traceparent(request),
    });
  }

  @Get(':workflowId/versions')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async versions(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = workflowParams(params);
    const input = workflowVersionsQuerySchema.parse(query ?? {});
    return this.listVersions.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
}

function guardAuthorization(
  request: WorkflowAuthoringRequest,
): Pick<WorkflowAuthoringRequest, 'authorizedWorkspace'> {
  return request.authorizedWorkspace === undefined
    ? {}
    : { authorizedWorkspace: request.authorizedWorkspace };
}

function workspaceParams(value: unknown): Readonly<{ workspaceId: string }> {
  return workflowWorkspaceParamSchema.parse(value);
}

function workflowParams(value: unknown): Readonly<{
  workspaceId: string;
  workflowId: string;
}> {
  return workflowIdParamSchema.parse(value);
}

function actorFrom(request: WorkflowAuthoringRequest, workspaceId: string) {
  if (request.authorizedWorkspace !== undefined)
    return request.authorizedWorkspace.actor;
  const session = authenticatedSession(request);
  const traceId = traceIdentifier(request);
  try {
    return createActorContext({
      actorId: session.userId,
      workspaceId,
      sessionId: session.sessionId,
      requestId: requestIdentifier(request),
      ...(traceId === undefined ? {} : { traceId }),
    });
  } catch (error: unknown) {
    return throwWorkflowApplicationError(
      applicationError('request.invalid', {
        safeDetail:
          error instanceof Error ? error.message : 'Invalid actor context',
      }),
    );
  }
}

function requestIdentifiers(request: WorkflowAuthoringRequest): Readonly<{
  requestId: string;
  traceId?: string;
}> {
  if (request.authorizedWorkspace !== undefined) {
    const actor = request.authorizedWorkspace.actor;
    return {
      requestId: actor.requestId,
      ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
    };
  }
  const requestId = requestIdentifier(request);
  const traceId = traceIdentifier(request);
  return {
    requestId,
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function traceparent(
  request: WorkflowAuthoringRequest,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined ? {} : { traceparent: value };
}
