import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  organizationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../platform/http/route.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { WorkflowOrganizationCommandsService } from './organization-commands.service.js';
import { withWorkflowOrganizationRequest } from './http.js';
import { WorkflowOrganizationReadsService } from './organization-reads.service.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowOrganizationController {
  public constructor(
    private readonly commands: WorkflowOrganizationCommandsService,
    private readonly reads: WorkflowOrganizationReadsService,
  ) {}

  @Route(routes.listTags)
  public listTags(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.listTags>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.reads.listTags({
        ...input,
        query: query,
      }),
    );
  }

  @Route(routes.createTag)
  public createTag(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.createTag>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.commands.createTag({
        ...input,
        idempotencyKey,
        request: body,
      }),
    );
  }

  @Route(routes.renameTag)
  public renameTag(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.renameTag>,
  ) {
    const { tagId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.commands.renameTag({
        ...input,
        idempotencyKey,
        tagId,
        request: body,
      }),
    );
  }

  @Route(routes.deleteTag)
  public deleteTag(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.deleteTag>,
  ) {
    const { tagId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.commands.deleteTag({
        ...input,
        idempotencyKey,
        tagId,
        request: body,
      }),
    );
  }

  @Route(routes.assignments)
  public assignments(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.assignments>,
  ) {
    const { tagId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.reads.listTagAssignments({
        ...input,
        tagId,
        query: query,
      }),
    );
  }

  @Route(routes.replaceTags)
  public replaceTags(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.replaceTags>,
  ) {
    const { workflowId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.commands.replaceTags({
        ...input,
        idempotencyKey,
        workflowId,
        request: body,
      }),
    );
  }

  @Route(routes.favorite)
  public favorite(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.favorite>,
  ) {
    const { workflowId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.commands.setFavorite({
        ...input,
        workflowId,
        request: body,
      }),
    );
  }
}
