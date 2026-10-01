import { Controller, Get, Header, Param, Req, UseGuards } from '@nestjs/common';
import { workflowRunListParamsSchema } from '@pertexo/contracts/workflow-runs';

import { SessionAuthenticationGuard } from '../identity-workspace/index.js';
import { optionalAuthorizedWorkspace } from '../identity-workspace/authenticated-command-context.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  UsageCapacityArtifactReadGuard,
  WorkflowRunReadGuard,
} from './guards.js';
import { actorFrom, type WorkflowRunsRequest } from './request-context.js';
import { GetUsageCapacityUseCase } from './usage-capacity-use-case.js';

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class UsageCapacityController {
  public constructor(
    private readonly getUsageCapacity: GetUsageCapacityUseCase,
  ) {}

  @Get('usage-capacity')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowRunReadGuard,
    UsageCapacityArtifactReadGuard,
  )
  public async getCapacity(
    @Req() request: WorkflowRunsRequest & AbortableRequest,
    @Param() params: unknown,
  ) {
    const route = workflowRunListParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.getUsageCapacity.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...optionalAuthorizedWorkspace(request),
        signal,
      }),
    );
  }
}
