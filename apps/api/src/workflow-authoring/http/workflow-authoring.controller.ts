import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  authoringRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import { In, Route } from '../../workspaces/http/route.js';

import { requestHeaderValue } from '../../platform/http/request-headers.js';

import { withWorkflowOrganizationRequest } from '../organization/http.js';
import { WorkflowOrganizationReadsUseCase } from '../organization/organization-reads.service.js';

import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { authoringFailure } from '../../problems/context/normalize.js';
import type {
  ConditionalWorkflowResponse,
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-transport.js';
import {
  CreateWorkflowUseCase,
  GetWorkflowDraftUseCase,
  GetWorkflowUseCase,
  ListWorkflowsUseCase,
  PublishWorkflowUseCase,
  SaveWorkflowDraftUseCase,
  ValidateWorkflowDraftUseCase,
} from '../workflow-authoring.service.js';
import { requestContext, traceparent } from './context.js';
import { parseStrongIfMatch } from './preconditions.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowAuthoringController {
  // Nest resolves these dependencies positionally; grouping them would change DI.
  // eslint-disable-next-line max-params
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

  @Route(routes.list)
  public async list(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
    @Res({ passthrough: true }) response?: WorkflowResponse,
  ) {
    const { workspaceId } = params;
    const input = query;
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

  @Route(routes.create)
  public async create(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const { workspaceId } = params;
    const context = requestContext(request, workspaceId);
    const result = await this.createWorkflow.execute({
      ...context,
      routeWorkspaceId: workspaceId,
      request: body,
      idempotencyKey: idempotencyKey,
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }

  @Route(routes.get)
  public async get(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.get>,
    @Res({ passthrough: true }) response?: WorkflowResponse,
  ) {
    const route = params;
    const projection = query;
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

  @Route(routes.draft)
  public async draft(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.draft>,
    @Res({ passthrough: true }) response: ConditionalWorkflowResponse,
  ) {
    const route = params;
    const context = requestContext(request, route.workspaceId);
    const result = await this.getDraft.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
    });
    response.header('ETag', result.representationTag);
    if (
      singleRequestHeader(request.headers, 'if-none-match') ===
      result.representationTag
    ) {
      response.status(304);
      return undefined;
    }
    return result.body;
  }

  @Route(routes.save)
  public async save(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body }: RouteInput<typeof routes.save>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const input = body;
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

  @Route(routes.validate)
  public async validate(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.validate>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
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

  @Route(routes.publish)
  public async publish(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.publish>,
  ) {
    const route = params;
    const context = requestContext(request, route.workspaceId);
    return withRequestOperationSignal(request, (signal) =>
      this.publishWorkflow.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        representationTag: parseStrongIfMatch(
          requestHeaderValue(request.headers, 'if-match'),
        ),
        idempotencyKey: idempotencyKey,
        ...traceparent(request),
        signal,
      }),
    );
  }
}
