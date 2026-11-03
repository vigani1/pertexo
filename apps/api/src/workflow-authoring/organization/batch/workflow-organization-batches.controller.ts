import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  batchRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../../problems/context/normalize.js';
import { In, Route } from '../../../workspaces/http/route.js';
import type { WorkflowAuthoringRequest } from '../../workflow-transport.js';
import { withWorkflowOrganizationRequest } from '../http.js';
import { WorkflowOrganizationBatchesUseCase } from './workflow-organization-batches.service.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowOrganizationBatchesController {
  public constructor(
    private readonly batches: WorkflowOrganizationBatchesUseCase,
  ) {}

  @Route(routes.bulk)
  public bulk(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.bulk>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.batches.bulk({
        ...input,
        request: body,
        idempotencyKey: idempotencyKey,
      }),
    );
  }

  @Route(routes.cleanup)
  public cleanup(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.cleanup>,
  ) {
    const { workspaceId } = params;
    return withWorkflowOrganizationRequest(request, workspaceId, (input) =>
      this.batches.cleanup({
        ...input,
        request: body,
        idempotencyKey: idempotencyKey,
      }),
    );
  }
}
