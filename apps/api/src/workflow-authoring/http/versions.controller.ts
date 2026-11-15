import {
  versionRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';

import { Controller, Req, Res, UseInterceptors } from '@nestjs/common';

import { requestHeaderValue } from '../../platform/http/request-headers.js';

import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import { RestoreWorkflowVersionService } from '../commands/restore-version.js';
import type {
  WorkflowAuthoringRequest,
  WorkflowResponse,
} from '../workflow-authoring-request.js';
import { ListWorkflowVersionsService } from '../workflow-authoring.service.js';
import { parseStrongIfMatch } from './preconditions.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';
@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WorkflowVersionsController {
  public constructor(
    private readonly listVersions: ListWorkflowVersionsService,
    private readonly restoreWorkflowVersion: RestoreWorkflowVersionService,
  ) {}

  @Route(routes.restoreVersion)
  public async restoreVersion(
    @Req() request: WorkflowAuthoringRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey }: RouteInput<typeof routes.restoreVersion>,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = params;
    const context = serviceCaller(caller);
    const result = await this.restoreWorkflowVersion.execute({
      ...context,
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
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.versions>,
  ) {
    const route = params;
    const input = query;
    const context = serviceCaller(caller);
    return this.listVersions.execute({
      ...context,
      workflowId: route.workflowId,
      includeGraphDigest: input.include === 'graphDigest',
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }
}
