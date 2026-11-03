import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowSettingsRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { WorkflowAutoPauseUseCase } from './auto-pause.js';
import { asker } from './asker.js';
import type { WorkflowAuthoringRequest } from '../workflow-transport.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowAutoPauseController {
  public constructor(private readonly controls: WorkflowAutoPauseUseCase) {}

  @Route(routes.autoPause)
  public async read(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.autoPause>,
  ) {
    return await this.controls.readWorkflow({
      ...asker(request, params),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.updateAutoPause)
  public async update(
    @Req() request: WorkflowAuthoringRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.updateAutoPause>,
  ) {
    return await this.controls.updateWorkflow({
      ...asker(request, params),
      request: body,
      idempotencyKey,
      workflowId: params.workflowId,
    });
  }

  @Route(routes.resume)
  public async resume(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.resume>,
  ) {
    return await this.controls.resume({
      ...asker(request, params),
      request: body,
      idempotencyKey,
      workflowId: params.workflowId,
    });
  }
}

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkspaceAutoPauseController {
  public constructor(private readonly controls: WorkflowAutoPauseUseCase) {}

  @Route(routes.workspaceAutoPause)
  public async read(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params }: RouteInput<typeof routes.workspaceAutoPause>,
  ) {
    return await this.controls.readWorkspace(asker(request, params));
  }

  @Route(routes.updateWorkspaceAutoPause)
  public async update(
    @Req() request: WorkflowAuthoringRequest,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.updateWorkspaceAutoPause>,
  ) {
    return await this.controls.updateWorkspace({
      ...asker(request, params),
      request: body,
      idempotencyKey,
    });
  }
}
