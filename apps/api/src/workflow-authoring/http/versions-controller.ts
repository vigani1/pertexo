import {
  versionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { requestContext } from './context.js';

import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';

import { requestHeaderValue } from '../../platform/http/request-headers.js';

import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';
import { RestoreWorkflowVersionUseCase } from '../commands/restore-version.js';
import type {
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-transport.js';
import { ListWorkflowVersionsUseCase } from '../workflow-authoring.service.js';
import { parseStrongIfMatch } from './preconditions.js';
@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowVersionsController {
  public constructor(
    private readonly listVersions: ListWorkflowVersionsUseCase,
    private readonly restoreWorkflowVersion: RestoreWorkflowVersionUseCase,
  ) {}

  @Route(routes.restoreVersion)
  public async restoreVersion(
    @Req() request: WorkflowAuthoringRequest,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.restoreVersion>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const context = requestContext(request, route.workspaceId);
    const result = await this.restoreWorkflowVersion.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      versionId: route.versionId,
      representationTag: parseStrongIfMatch(
        requestHeaderValue(request.headers, 'if-match'),
      ),
      request: body,
      idempotencyKey,
    });
    response.header('ETag', result.representationTag);
    return result.body;
  }

  @Route(routes.versions)
  public async versions(
    @Req() request: WorkflowAuthoringRequest,
    @In() { params, query }: RouteInput<typeof routes.versions>,
  ) {
    const route = params;
    const input = query;
    const context = requestContext(request, route.workspaceId);
    return this.listVersions.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
}
