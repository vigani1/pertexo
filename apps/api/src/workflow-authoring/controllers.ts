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
import { createActorContext } from '../workspaces/index.js';
import { mapWorkflowAuthoringError } from './errors.js';
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
  workflowCreateRequestSchema,
  workflowDraftSaveRequestSchema,
  workflowIdParamSchema,
  workflowListQuerySchema,
  workflowVersionsQuerySchema,
  type WorkflowAuthoringRequest,
  type WorkflowResponse,
} from './types.js';

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
  ) {}

  @Get()
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async list(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    try {
      const { workspaceId } = workspaceParams(params);
      const input = workflowListQuerySchema.parse(query ?? {});
      return await this.listWorkflows.execute({
        actor: actorFrom(request, workspaceId),
        routeWorkspaceId: workspaceId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined ? {} : { after: input.after }),
      });
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
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
    try {
      const { workspaceId } = workspaceParams(params);
      const input = workflowCreateRequestSchema.parse(body);
      const result = await this.createWorkflow.execute({
        actor: actorFrom(request, workspaceId),
        routeWorkspaceId: workspaceId,
        name: input.name,
        idempotencyKey: parseIdempotencyKey(
          requestHeaderValue(request.headers, 'idempotency-key'),
        ),
        ...requestIdentifiers(request),
      });
      response.header('ETag', result.representationTag);
      return result.body;
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Get(':workflowId/draft')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async draft(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    try {
      const route = workflowParams(params);
      const result = await this.getDraft.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
      });
      response.header('ETag', result.representationTag);
      return result.body;
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
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
    try {
      const route = workflowParams(params);
      const input = workflowDraftSaveRequestSchema.parse(body);
      const result = await this.saveDraft.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        representationTag: parseStrongIfMatch(
          requestHeaderValue(request.headers, 'if-match'),
        ),
        graph: input.graph,
        ...requestIdentifiers(request),
      });
      response.header('ETag', result.representationTag);
      return result.body;
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Post(':workflowId/validate')
  @RateLimit('workflow_compile')
  @HttpCode(200)
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard, CsrfProtectionGuard)
  public async validate(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    try {
      const route = workflowParams(params);
      return await this.validateDraft.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
      });
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
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
    try {
      const route = workflowParams(params);
      return await this.publishWorkflow.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
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
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Get(':workflowId/versions')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async versions(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    try {
      const route = workflowParams(params);
      const input = workflowVersionsQuerySchema.parse(query ?? {});
      return await this.listVersions.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined ? {} : { after: input.after }),
      });
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
  }
}

function workspaceParams(value: unknown): Readonly<{ workspaceId: string }> {
  if (typeof value !== 'object' || value === null || !('workspaceId' in value))
    return throwWorkflowApplicationError(applicationError('request.invalid'));
  const workspaceId = (value as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== 'string')
    return throwWorkflowApplicationError(applicationError('request.invalid'));
  return { workspaceId };
}

function workflowParams(value: unknown): Readonly<{
  workspaceId: string;
  workflowId: string;
}> {
  return workflowIdParamSchema.parse(value);
}

function actorFrom(request: WorkflowAuthoringRequest, workspaceId: string) {
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

function throwWorkflowApplicationError(error: unknown): never {
  const mapped = mapWorkflowAuthoringError(error);
  // The shared problem filter consumes frozen application errors.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw mapped;
}
