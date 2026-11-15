import { traceparent } from '../../platform/http/tracing-headers.js';
import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  authoringRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import { In, Route } from '../../platform/http/route.js';

import { requestHeaderValue } from '../../platform/http/request-headers.js';

import { withWorkflowOrganizationRequest } from '../organization/http.js';
import { WorkflowOrganizationReadsService } from '../organization/organization-reads.service.js';

import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import type {
  ConditionalWorkflowResponse,
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-authoring-request.js';
import {
  CreateWorkflowService,
  GetWorkflowDraftService,
  GetWorkflowService,
  ListWorkflowsService,
  PublishWorkflowService,
  SaveWorkflowDraftService,
  ValidateWorkflowDraftService,
} from '../workflow-authoring.service.js';
import { parseStrongIfMatch } from './preconditions.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowAuthoringController {
  // Nest resolves these dependencies positionally; grouping them would change DI.
  // eslint-disable-next-line max-params
  public constructor(
    private readonly listWorkflows: ListWorkflowsService,
    private readonly createWorkflow: CreateWorkflowService,
    private readonly getWorkflow: GetWorkflowService,
    private readonly getDraft: GetWorkflowDraftService,
    private readonly saveDraft: SaveWorkflowDraftService,
    private readonly validateDraft: ValidateWorkflowDraftService,
    private readonly publishWorkflow: PublishWorkflowService,
    private readonly organization: WorkflowOrganizationReadsService,
  ) {}

  @Route(routes.list)
  public async list(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.list>,
    @Res({ passthrough: true }) response?: WorkflowResponse,
  ) {
    const input = query;
    const hasOrganizationFilters =
      input.query !== undefined ||
      input.view !== undefined ||
      input.tagId !== undefined ||
      input.folderId !== undefined ||
      input.favoritesOnly !== undefined ||
      (input.include?.includes('organization') ?? false);
    if (hasOrganizationFilters) {
      response?.header('Cache-Control', 'private, no-store');
      return withWorkflowOrganizationRequest(request, caller, (context) =>
        this.organization.list({
          ...context,
          query: input,
        }),
      );
    }
    const context = serviceCaller(caller);
    return this.listWorkflows.execute({
      ...context,
      includeListSummary: input.include === 'listSummary',
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
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const context = serviceCaller(caller);
    const result = await this.createWorkflow.execute({
      ...context,
      request: body,
      idempotencyKey: idempotencyKey,
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }

  @Route(routes.get)
  public async get(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
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
      return withWorkflowOrganizationRequest(request, caller, (context) =>
        this.organization.get({
          ...context,
          workflowId: route.workflowId,
          query: projection,
        }),
      );
    return this.getWorkflow.execute({
      ...serviceCaller(caller),
      workflowId: route.workflowId,
      ...(projection.include === undefined
        ? {}
        : { include: projection.include }),
    });
  }

  @Route(routes.draft)
  public async draft(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.draft>,
    @Res({ passthrough: true }) response: ConditionalWorkflowResponse,
  ) {
    const route = params;
    const context = serviceCaller(caller);
    const result = await this.getDraft.execute({
      ...context,
      workflowId: route.workflowId,
      includeGraphDigest: query.include === 'graphDigest',
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
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.save>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const input = body;
    const context = serviceCaller(caller);
    const result = await this.saveDraft.execute({
      ...context,
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
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.validate>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const context = serviceCaller(caller);
    const result = await withRequestOperationSignal(request, (signal) =>
      this.validateDraft.execute({
        ...context,
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
    @Caller() caller: WorkspaceCaller,
    @In() { params, idempotencyKey }: RouteInput<typeof routes.publish>,
  ) {
    const route = params;
    const context = serviceCaller(caller);
    return withRequestOperationSignal(request, (signal) =>
      this.publishWorkflow.execute({
        ...context,
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
