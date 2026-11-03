import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import {
  nodeTestingRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { projectAuthenticatedWorkspaceContext } from '../workspaces/request/authenticated-context.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import { In, Route } from '../workspaces/http/route.js';
import { requestIdempotencyKey } from '../platform/http/index.js';
import { singleRequestHeader } from '../platform/http/request-headers.js';
import {
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from './node-testing.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../problems/context/normalize.js';

interface StatusResponse {
  status(code: number): unknown;
}

@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller()
export class NodeTestingController {
  public constructor(
    private readonly testNode: TestWorkflowNodeUseCase,
    private readonly getPreview: GetPreviewRunUseCase,
  ) {}

  @Route(routes.preview)
  public async status(
    @Req() request: IdentityWorkspaceRequest,
    @In() { params }: RouteInput<typeof routes.preview>,
  ) {
    const context = projectAuthenticatedWorkspaceContext(
      request,
      params.workspaceId,
    );
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
    @In() { params, body }: RouteInput<typeof routes.test>,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    const executing = body.mode === 'test_execute';
    const idempotencyKey = executing
      ? requestIdempotencyKey(request.headers)
      : undefined;
    const traceparent = singleRequestHeader(request.headers, 'traceparent');
    const result = await this.testNode.execute({
      ...projectAuthenticatedWorkspaceContext(request, params.workspaceId),
      routeWorkspaceId: params.workspaceId,
      workflowId: params.workflowId,
      nodeId: params.nodeId,
      request: body,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    if (executing) response.status(202);
    return result;
  }
}
