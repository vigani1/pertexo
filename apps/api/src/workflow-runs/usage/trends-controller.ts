import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  usageTrendsQuerySchema,
  workflowRunListParamsSchema,
} from '@pertexo/contracts';
import { SessionAuthenticationGuard } from '../../workspaces/index.js';
import { optionalAuthorizedWorkspace } from '../../workspaces/request/authenticated-context.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WorkflowRunReadGuard } from '../http/guards.js';
import {
  actorFrom,
  type WorkflowRunsRequest,
} from '../http/request-context.js';
import { GetUsageTrendsUseCase } from './trends.js';

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class UsageTrendsController {
  constructor(private readonly trends: GetUsageTrendsUseCase) {}
  @Get('usage-trends')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  async get(
    @Req() request: WorkflowRunsRequest & AbortableRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = workflowRunListParamsSchema.parse(params);
    const { period = '30d' } = usageTrendsQuerySchema.parse(query);
    return withRequestOperationSignal(request, (signal) =>
      this.trends.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        period,
        signal,
        ...optionalAuthorizedWorkspace(request),
      }),
    );
  }
}
