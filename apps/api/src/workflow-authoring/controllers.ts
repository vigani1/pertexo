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
} from '../identity-workspace/index.js';
import { applicationError } from '../platform/http/index.js';
import { createActorContext } from '../workspaces/index.js';
import { mapWorkflowAuthoringError } from './errors.js';
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
  @UseGuards(SessionAuthenticationGuard)
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
  @HttpCode(201)
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
  public async create(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId } = workspaceParams(params);
      const input = workflowCreateRequestSchema.parse(body);
      return await this.createWorkflow.execute({
        actor: actorFrom(request, workspaceId),
        routeWorkspaceId: workspaceId,
        name: input.name,
        idempotencyKey: parseIdempotencyKey(header(request, 'idempotency-key')),
        ...requestIdentifiers(request),
      });
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Get(':workflowId/draft')
  @UseGuards(SessionAuthenticationGuard)
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
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
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
        representationTag: parseStrongIfMatch(header(request, 'if-match')),
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
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
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
  @UseGuards(SessionAuthenticationGuard, CsrfProtectionGuard)
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
        representationTag: parseStrongIfMatch(header(request, 'if-match')),
        idempotencyKey: parseIdempotencyKey(header(request, 'idempotency-key')),
        ...requestIdentifiers(request),
        ...traceparent(request),
      });
    } catch (error: unknown) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Get(':workflowId/versions')
  @UseGuards(SessionAuthenticationGuard)
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
  try {
    return createActorContext({
      actorId: session.userId,
      workspaceId,
      sessionId: session.sessionId,
      requestId:
        request.requestId ??
        headerString(request, 'x-request-id') ??
        'workflow-request',
      ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
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
  requestId?: string;
  traceId?: string;
}> {
  const requestId = headerString(request, 'x-request-id') ?? request.requestId;
  const traceId = request.traceId ?? headerString(request, 'traceparent');
  return {
    ...(requestId === undefined ? {} : { requestId }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function traceparent(
  request: WorkflowAuthoringRequest,
): Readonly<{ traceparent?: string }> {
  const value = headerString(request, 'traceparent');
  return value === undefined ? {} : { traceparent: value };
}

function header(request: WorkflowAuthoringRequest, name: string): unknown {
  const headers = request.headers;
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : headers[key];
}

function headerString(
  request: WorkflowAuthoringRequest,
  name: string,
): string | undefined {
  const value = header(request, name);
  if (typeof value === 'string') return value;
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === 'string'
  )
    return value[0];
  return undefined;
}

function throwWorkflowApplicationError(error: unknown): never {
  const mapped = mapWorkflowAuthoringError(error);
  // The shared problem filter consumes frozen application errors.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw mapped;
}
