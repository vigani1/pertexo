import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  foldersRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../../platform/http/route.js';
import type { WorkflowAuthoringRequest } from '../../workflow-authoring-request.js';
import { withWorkflowOrganizationRequest } from '../http.js';
import { WorkflowFoldersService } from './workflow-folders.service.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowFoldersController {
  public constructor(private readonly folders: WorkflowFoldersService) {}

  @Route(routes.list)
  public list(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.list>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.list({
        ...input,
        query: query,
      }),
    );
  }

  @Route(routes.sharingPrincipals)
  public sharingPrincipals(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.sharingPrincipals>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.sharingPrincipals({ ...input, query }),
    );
  }

  @Route(routes.readSharing)
  public readSharing(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.readSharing>,
  ) {
    const { folderId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.readSharing({ ...input, folderId }),
    );
  }

  @Route(routes.replaceSharing)
  public replaceSharing(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.replaceSharing>,
  ) {
    const { folderId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.replaceSharing({
        ...input,
        idempotencyKey,
        folderId,
        request: body,
      }),
    );
  }

  @Route(routes.reviewMove)
  public reviewMove(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body }: RouteInput<typeof routes.reviewMove>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.reviewMove({ ...input, request: body }),
    );
  }

  @Route(routes.create)
  public create(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.create({
        ...input,
        idempotencyKey,
        request: body,
      }),
    );
  }

  @Route(routes.rename)
  public rename(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.rename>,
  ) {
    const { folderId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.rename({
        ...input,
        idempotencyKey,
        folderId,
        request: body,
      }),
    );
  }

  @Route(routes.move)
  public move(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.move>,
  ) {
    const { folderId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.move({
        ...input,
        idempotencyKey,
        folderId,
        request: body,
      }),
    );
  }

  @Route(routes.delete)
  public delete(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.delete>,
  ) {
    const { folderId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.delete({
        ...input,
        idempotencyKey,
        folderId,
        request: body,
      }),
    );
  }

  @Route(routes.place)
  public place(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.place>,
  ) {
    const { workflowId } = params;
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.folders.place({
        ...input,
        idempotencyKey,
        workflowId,
        request: body,
      }),
    );
  }
}
