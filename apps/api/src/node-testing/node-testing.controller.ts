import { traceparent } from '../platform/http/tracing-headers.js';
import {
  Controller,
  Req,
  Res,
  UseInterceptors,
  HttpStatus,
} from '@nestjs/common';
import {
  nodeTestingRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { In, Route } from '../platform/http/route.js';
import { requestIdempotencyKey } from '../platform/http/index.js';
import { GetPreviewRunService } from './previews/read.js';
import { TestWorkflowNodeService } from './node-testing.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

interface StatusResponse {
  status(code: number): unknown;
}

@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller()
export class NodeTestingController {
  public constructor(
    private readonly testNode: TestWorkflowNodeService,
    private readonly getPreview: GetPreviewRunService,
  ) {}

  @Route(routes.preview)
  public async status(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.preview>,
  ) {
    const context = serviceCaller(caller);
    return this.getPreview.execute({
      actor: context.actor,
      routeWorkspaceId: params.workspaceId,
      ...(context.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: context.authorizedWorkspace }),
      previewRunId: params.previewRunId,
    });
  }

  /** Validating answers at once; executing queues a durable test and answers 202. */
  @Route(routes.test)
  public async test(
    @Req() request: IdentityWorkspaceRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.test>,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    const executing = body.mode === 'test_execute';
    const idempotencyKey = executing
      ? requestIdempotencyKey(request.headers)
      : undefined;
    const result = await this.testNode.execute({
      ...serviceCaller(caller),
      workflowId: params.workflowId,
      nodeId: params.nodeId,
      request: body,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...traceparent(request),
    });
    if (executing) response.status(HttpStatus.ACCEPTED);
    return result;
  }
}
