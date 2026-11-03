import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowSettingsRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WorkflowErrorUseCase } from './error-workflow.js';
import { asker } from './asker.js';
import type { WorkflowAuthoringRequest } from '../types.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

type Request = WorkflowAuthoringRequest & AbortableRequest;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowErrorController {
  public constructor(private readonly controls: WorkflowErrorUseCase) {}

  @Route(routes.errorTargets)
  public async targets(
    @Req() request: Request,
    @In() { params, query }: RouteInput<typeof routes.errorTargets>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.targets({
        ...asker(request, params),
        workflowId: params.workflowId,
        request: query,
        signal,
      }),
    );
  }

  @Route(routes.errorWorkflow)
  public async read(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.errorWorkflow>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.read({
        ...asker(request, params),
        workflowId: params.workflowId,
        signal,
      }),
    );
  }

  @Route(routes.updateErrorWorkflow)
  public async update(
    @Req() request: Request,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.updateErrorWorkflow>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.update({
        ...asker(request, params),
        workflowId: params.workflowId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
}
