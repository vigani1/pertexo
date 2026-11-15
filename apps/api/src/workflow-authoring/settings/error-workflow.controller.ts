import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowSettingsRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WorkflowErrorService } from './error-workflow.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring-request.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

type Request = WorkflowAuthoringRequest & AbortableRequest;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowErrorController {
  public constructor(private readonly controls: WorkflowErrorService) {}

  @Route(routes.errorTargets)
  public async targets(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.errorTargets>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.targets({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        request: query,
        signal,
      }),
    );
  }

  @Route(routes.errorWorkflow)
  public async read(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.errorWorkflow>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.read({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        signal,
      }),
    );
  }

  @Route(routes.updateErrorWorkflow)
  public async update(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.updateErrorWorkflow>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.update({
        ...serviceCaller(caller),
        workflowId: params.workflowId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}
