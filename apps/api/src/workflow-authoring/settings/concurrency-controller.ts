import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowSettingsRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WorkflowConcurrencyUseCase } from './concurrency.js';
import { asker } from './asker.js';
import type { WorkflowAuthoringRequest } from '../workflow-transport.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';

type Request = WorkflowAuthoringRequest & AbortableRequest;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowConcurrencyController {
  public constructor(private readonly controls: WorkflowConcurrencyUseCase) {}

  @Route(routes.concurrency)
  public async read(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.concurrency>,
  ) {
    return await withRequestOperationSignal(request, (signal) =>
      this.controls.read({
        ...asker(request, params),
        workflowId: params.workflowId,
        signal,
      }),
    );
  }

  @Route(routes.updateConcurrency)
  public async update(
    @Req() request: Request,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.updateConcurrency>,
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
