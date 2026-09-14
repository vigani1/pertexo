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
} from '../identity-workspace/index.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { applicationError } from '../platform/http/index.js';
import {
  requestHeaderValue,
  singleRequestHeader,
} from '../platform/http/request-headers.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { TransitionWorkflowLifecycleUseCase } from './lifecycle-use-case.js';
import { RestoreWorkflowVersionUseCase } from './restore-version-use-case.js';
import { workflowVersionRestoreParamsSchema } from '@pertexo/contracts/workflow-authoring';
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
    private readonly restoreWorkflowVersion: RestoreWorkflowVersionUseCase,
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
    const context = requestContext(request, workspaceId);
    return this.listWorkflows.execute({
      ...context,
      routeWorkspaceId: workspaceId,
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
    const context = requestContext(request, workspaceId);
    const result = await this.createWorkflow.execute({
      ...context,
      routeWorkspaceId: workspaceId,
      request: body,
      idempotencyKey: parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      ),
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
    const context = requestContext(request, route.workspaceId);
    const result = await this.getDraft.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
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
    const context = requestContext(request, route.workspaceId);
    const result = await this.saveDraft.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      representationTag: parseStrongIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      ),
      graph: input.graph,
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
    const context = requestContext(request, route.workspaceId);
    return this.validateDraft.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
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
    const context = requestContext(request, route.workspaceId);
    return this.publishWorkflow.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      representationTag: parseStrongIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      ),
      idempotencyKey: parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      ),
      ...traceparent(request),
    });
  }

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
    const context = requestContext(request, route.workspaceId);
    return this.transitionLifecycle.execute({
      command,
      ...context,
      routeWorkspaceId: route.workspaceId,
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
    const context = requestContext(request, route.workspaceId);
    return this.listVersions.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
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

function requestContext(
  request: WorkflowAuthoringRequest,
  workspaceId: string,
) {
  try {
    return projectAuthenticatedWorkspaceContext(request, workspaceId);
  } catch (error: unknown) {
    return throwWorkflowApplicationError(
      applicationError('request.invalid', {
        safeDetail:
          error instanceof Error ? error.message : 'Invalid actor context',
      }),
    );
  }
}

function traceparent(
  request: WorkflowAuthoringRequest,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined ? {} : { traceparent: value };
}
