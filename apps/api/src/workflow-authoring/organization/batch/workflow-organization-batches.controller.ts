import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  batchRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { domainErrors } from '../../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../../problems/context/normalize-context-errors.js';
import { In, Route } from '../../../platform/http/route.js';
import type { WorkflowAuthoringRequest } from '../../workflow-authoring-request.js';
import { withWorkflowOrganizationRequest } from '../http.js';
import { WorkflowOrganizationBatchesService } from './workflow-organization-batches.service.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../../workspaces/request/caller.js';

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowOrganizationBatchesController {
  public constructor(
    private readonly batches: WorkflowOrganizationBatchesService,
  ) {}

  @Route(routes.bulk)
  public bulk(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.bulk>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
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
    @Caller() caller: WorkspaceCaller,
    @In() { body, idempotencyKey }: RouteInput<typeof routes.cleanup>,
  ) {
    return withWorkflowOrganizationRequest(request, caller, (input) =>
      this.batches.cleanup({
        ...input,
        request: body,
        idempotencyKey: idempotencyKey,
      }),
    );
  }
}
