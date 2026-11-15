import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowSettingsRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import { WorkflowAutoPauseService } from './auto-pause.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowAutoPauseController {
  public constructor(private readonly controls: WorkflowAutoPauseService) {}

  @Route(routes.autoPause)
  public async read(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.autoPause>,
  ) {
    return await this.controls.readWorkflow({
      ...serviceCaller(caller),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.updateAutoPause)
  public async update(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.updateAutoPause>,
  ) {
    return await this.controls.updateWorkflow({
      ...serviceCaller(caller),
      request: body,
      idempotencyKey,
      workflowId: params.workflowId,
    });
  }

  @Route(routes.resume)
  public async resume(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.resume>,
  ) {
    return await this.controls.resume({
      ...serviceCaller(caller),
      request: body,
      idempotencyKey,
      workflowId: params.workflowId,
    });
  }
}

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkspaceAutoPauseController {
  public constructor(private readonly controls: WorkflowAutoPauseService) {}

  @Route(routes.workspaceAutoPause)
  public async read(@Caller() caller: WorkspaceCaller) {
    return await this.controls.readWorkspace(serviceCaller(caller));
  }

  @Route(routes.updateWorkspaceAutoPause)
  public async update(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    {
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.updateWorkspaceAutoPause>,
  ) {
    return await this.controls.updateWorkspace({
      ...serviceCaller(caller),
      request: body,
      idempotencyKey,
    });
  }
}
