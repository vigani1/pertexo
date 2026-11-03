import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  foldersRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../../problems/context/normalize.js';
import { In, Route } from '../../../workspaces/http/route.js';
import type { WorkflowAuthoringRequest } from '../../types.js';
import { withWorkflowOrganizationRequest } from '../http.js';
import { WorkflowFoldersUseCase } from './workflow-folders.service.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowFoldersController {
  public constructor(private readonly folders: WorkflowFoldersUseCase) {}

  @Route(routes.list)
  public list(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.list({
        ...input,
        query: query,
      }),
    );
  }

  @Route(routes.sharingPrincipals)
  public sharingPrincipals(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.sharingPrincipals>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.sharingPrincipals({ ...input, query }),
    );
  }

  @Route(routes.readSharing)
  public readSharing(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.readSharing>,
  ) {
    const { workspaceId, folderId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.readSharing({ ...input, folderId }),
    );
  }

  @Route(routes.replaceSharing)
  public replaceSharing(
    @Req() request: WorkflowAuthoringRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.replaceSharing>,
  ) {
    const { workspaceId, folderId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body }: RouteInput<typeof routes.reviewMove>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.reviewMove({ ...input, request: body }),
    );
  }

  @Route(routes.create)
  public create(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.create>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.rename>,
  ) {
    const { workspaceId, folderId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.move>,
  ) {
    const { workspaceId, folderId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.delete>,
  ) {
    const { workspaceId, folderId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
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
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.place>,
  ) {
    const { workspaceId, workflowId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.folders.place({
        ...input,
        idempotencyKey,
        workflowId,
        request: body,
      }),
    );
  }
}
