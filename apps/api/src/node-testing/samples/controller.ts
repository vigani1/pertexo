import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  nodeTestParamsSchema,
  workflowIdParamSchema,
} from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { NodeSamplesReadGuard, NodeTestingUpdateGuard } from '../guards.js';
import { StepSamplesUseCase } from './use-case.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/draft')
@RateLimit('authenticated_read')
export class StepSamplesController {
  constructor(private readonly samples: StepSamplesUseCase) {}
  @Get('samples')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, NodeSamplesReadGuard)
  async list(@Req() request: Request, @Param() params: unknown) {
    const route = workflowIdParamSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.samples.list({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        signal,
      }),
    );
  }
  @Get('nodes/:nodeId/sample')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, NodeSamplesReadGuard)
  async get(@Req() request: Request, @Param() params: unknown) {
    const route = nodeTestParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.samples.get({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        nodeId: route.nodeId,
        signal,
      }),
    );
  }
  @Put('nodes/:nodeId/sample')
  @HttpCode(200)
  @RateLimit('preview_test')
  @UseGuards(
    SessionAuthenticationGuard,
    NodeTestingUpdateGuard,
    CsrfProtectionGuard,
  )
  async put(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = nodeTestParamsSchema.parse(params);
    const key = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.samples.put({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        nodeId: route.nodeId,
        request: body,
        idempotencyKey: key,
        signal,
      }),
    );
  }
  @Delete('nodes/:nodeId/sample')
  @HttpCode(200)
  @RateLimit('preview_test')
  @UseGuards(
    SessionAuthenticationGuard,
    NodeTestingUpdateGuard,
    CsrfProtectionGuard,
  )
  async remove(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = nodeTestParamsSchema.parse(params);
    const key = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.samples.remove({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        nodeId: route.nodeId,
        request: body,
        idempotencyKey: key,
        signal,
      }),
    );
  }
}
function context(request: Request, workspaceId: string) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
  };
}
