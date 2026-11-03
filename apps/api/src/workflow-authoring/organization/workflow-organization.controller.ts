import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  organizationRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';
import { In, Route } from '../../workspaces/http/route.js';
import type { WorkflowAuthoringRequest } from '../workflow-transport.js';
import { WorkflowOrganizationCommandsUseCase } from './commands.js';
import { withWorkflowOrganizationRequest } from './http.js';
import { WorkflowOrganizationReadsUseCase } from './reads.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowOrganizationController {
  public constructor(
    private readonly commands: WorkflowOrganizationCommandsUseCase,
    private readonly reads: WorkflowOrganizationReadsUseCase,
  ) {}

  @Route(routes.listTags)
  public listTags(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.listTags>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.reads.listTags({
        ...input,
        query: query,
      }),
    );
  }

  @Route(routes.createTag)
  public createTag(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.createTag>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.renameTag>,
  ) {
    const { workspaceId, tagId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.deleteTag>,
  ) {
    const { workspaceId, tagId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, query }: RouteInput<typeof routes.assignments>,
  ) {
    const { workspaceId, tagId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.replaceTags>,
  ) {
    const { workspaceId, workflowId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body }: RouteInput<typeof routes.favorite>,
  ) {
    const { workspaceId, workflowId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.commands.setFavorite({
        ...input,
        workflowId,
        request: body,
      }),
    );
  }
}
