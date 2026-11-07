import {
  lifecycleRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { requestContext, traceparent } from './context.js';

import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';

import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { DuplicateWorkflowUseCase } from '../commands/duplicate.js';
import { TransitionWorkflowLifecycleUseCase } from '../commands/lifecycle.js';
import { RenameWorkflowUseCase } from '../commands/rename.js';

import { parseStrongIfMatch } from './preconditions.js';

import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import type {
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-transport.js';
@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowLifecycleController {
  public constructor(
    private readonly transitionLifecycle: TransitionWorkflowLifecycleUseCase,
    private readonly renameWorkflow: RenameWorkflowUseCase,
    private readonly duplicateWorkflow: DuplicateWorkflowUseCase,
  ) {}

  @Route(routes.archive)
  public archive(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.archive>,
  ) {
    return this.lifecycleCommand('archive', request, {
      params,
      body,
      idempotencyKey,
    });
  }

  @Route(routes.restore)
  public restore(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.restore>,
  ) {
    return this.lifecycleCommand('restore', request, {
      params,
      body,
      idempotencyKey,
    });
  }

  @Route(routes.rename)
  public rename(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.rename>,
  ) {
    const route = params;
    return this.renameWorkflow.execute({
      ...requestContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      request: body,
      idempotencyKey: idempotencyKey,
    });
  }

  @Route(routes.duplicate)
  public async duplicate(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.duplicate>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const input = body;
    const representationTag =
      input.source.kind === 'draft'
        ? parseStrongIfMatch(requestHeaderValue(request.headers, 'if-match'))
        : undefined;
    const context = requestContext(request, route.workspaceId);
    const result = await withRequestOperationSignal(request, (signal) =>
      this.duplicateWorkflow.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        request: input,
        idempotencyKey: idempotencyKey,
        ...(representationTag === undefined ? {} : { representationTag }),
        signal,
      }),
    );
    response.header(
      'Location',
      `/v1/workspaces/${route.workspaceId}/workflows/${result.workflowId}`,
    );
    return result;
  }
  private lifecycleCommand(
    command: 'archive' | 'restore',
    request: WorkflowAuthoringRequest,
    {
      params,
      body,
      idempotencyKey,
    }: Pick<
      RouteInput<typeof routes.archive>,
      'params' | 'body' | 'idempotencyKey'
    >,
  ) {
    const route = params;
    const context = requestContext(request, route.workspaceId);
    return this.transitionLifecycle.execute({
      command,
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      request: body,
      idempotencyKey: idempotencyKey,
      ...traceparent(request),
    });
  }
}
