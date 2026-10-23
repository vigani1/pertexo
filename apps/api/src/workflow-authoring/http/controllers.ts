import { AutomationAuthenticationGuard } from '../../authentication/automation/guard.js';
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
  UseInterceptors,
} from '@nestjs/common';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';

import {
  parseRequestBody,
  requestIdempotencyKey,
} from '../../platform/http/index.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';

import {
  workflowOrganizationListQuerySchema,
  workflowGetQuerySchema,
} from '@pertexo/contracts';
import { WorkflowOrganizationReadsUseCase } from '../organization/reads.js';
import { withWorkflowOrganizationRequest } from '../organization/http.js';

import {
  WorkflowCreateGuard,
  WorkflowPublishGuard,
  WorkflowReadGuard,
  WorkflowUpdateGuard,
} from './guards.js';
import { parseStrongIfMatch } from './preconditions.js';
import {
  CreateWorkflowUseCase,
  GetWorkflowUseCase,
  GetWorkflowDraftUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from '../use-cases.js';
import {
  workflowDraftSaveRequestSchema,
  type WorkflowAuthoringRequest,
  type WorkflowResponse,
} from '../types.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';
import {
  workspaceParams,
  workflowParams,
  requestContext,
  traceparent,
} from './context.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller('v1/workspaces/:workspaceId/workflows')
@RateLimit('authenticated_read')
export class WorkflowAuthoringController {
  public constructor(
    private readonly listWorkflows: ListWorkflowsUseCase,
    private readonly createWorkflow: CreateWorkflowUseCase,
    private readonly getWorkflow: GetWorkflowUseCase,
    private readonly getDraft: GetWorkflowDraftUseCase,
    private readonly saveDraft: SaveWorkflowDraftUseCase,
    private readonly validateDraft: ValidateWorkflowDraftUseCase,
    private readonly publishWorkflow: PublishWorkflowUseCase,
    private readonly organization: WorkflowOrganizationReadsUseCase,
  ) {}
  @Get()
  @UseGuards(AutomationAuthenticationGuard, WorkflowReadGuard)
  public async list(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query: unknown,
    @Res({ passthrough: true }) response?: WorkflowResponse,
  ) {
    const { workspaceId } = workspaceParams(params);
    const input = workflowOrganizationListQuerySchema.parse(query ?? {});
    const hasOrganizationFilters =
      input.query !== undefined ||
      input.view !== undefined ||
      input.tagId !== undefined ||
      input.folderId !== undefined ||
      input.favoritesOnly !== undefined ||
      input.include !== undefined;
    if (hasOrganizationFilters) {
      response?.header('Cache-Control', 'private, no-store');
      return withWorkflowOrganizationRequest(request, workspaceId, (context) =>
        this.organization.list({
          ...context,
          query: input,
        }),
      );
    }
    const context = requestContext(request, workspaceId);
    return this.listWorkflows.execute({
      ...context,
      routeWorkspaceId: workspaceId,
      ...(input.pinsWorkflowId === undefined
        ? {}
        : { pinsWorkflowId: input.pinsWorkflowId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.order === undefined ? {} : { order: input.order }),
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
      idempotencyKey: requestIdempotencyKey(request.headers),
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }
  @Get(':workflowId')
  @UseGuards(AutomationAuthenticationGuard, WorkflowReadGuard)
  public async get(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Query() query?: unknown,
    @Res({ passthrough: true }) response?: WorkflowResponse,
  ) {
    const route = workflowParams(params);
    const projection = workflowGetQuerySchema.parse(query ?? {});
    if (projection.include !== undefined)
      response?.header('Cache-Control', 'private, no-store');
    if (
      projection.include === 'organization' ||
      projection.include === 'templateOrigin,organization'
    )
      return withWorkflowOrganizationRequest(
        request,
        route.workspaceId,
        (context) =>
          this.organization.get({
            ...context,
            workflowId: route.workflowId,
            query: projection,
          }),
      );
    return this.getWorkflow.execute({
      ...requestContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      ...(projection.include === undefined
        ? {}
        : { include: projection.include }),
    });
  }
  @Get(':workflowId/draft')
  @UseGuards(AutomationAuthenticationGuard, WorkflowReadGuard)
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
    const input = parseRequestBody(workflowDraftSaveRequestSchema, body);
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
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = workflowParams(params);
    const context = requestContext(request, route.workspaceId);
    const result = await withRequestOperationSignal(request, (signal) =>
      this.validateDraft.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        signal,
      }),
    );
    response.header('ETag', result.representationTag);
    return result.body;
  }
  @Post(':workflowId/publish')
  @RateLimit('workflow_compile')
  @HttpCode(200)
  @UseGuards(
    AutomationAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public async publish(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    const route = workflowParams(params);
    const context = requestContext(request, route.workspaceId);
    return withRequestOperationSignal(request, (signal) =>
      this.publishWorkflow.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        representationTag: parseStrongIfMatch(
          requestHeaderValue(request.headers, 'if-match'),
        ),
        idempotencyKey: requestIdempotencyKey(request.headers),
        ...traceparent(request),
        signal,
      }),
    );
  }
}
