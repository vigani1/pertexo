import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  workflowTestCancelRequestSchema,
  workflowIdParamSchema,
  workflowTestParamsSchema,
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
import { NodeTestingUpdateGuard } from '../guards.js';
import { WorkflowTestsUseCase } from './use-case.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/draft/tests')
@UseGuards(SessionAuthenticationGuard, NodeTestingUpdateGuard)
@RateLimit('authenticated_read')
export class WorkflowTestsController {
  constructor(private readonly tests: WorkflowTestsUseCase) {}
  @Get('prepare')
  @RateLimit('workflow_compile')
  @Header('Cache-Control', 'private, no-store')
  prepare(@Req() request: Request, @Param() params: unknown) {
    const route = workflowIdParamSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.tests.prepare({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        signal,
      }),
    );
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Req() request: Request, @Param() params: unknown) {
    const route = workflowIdParamSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.tests.list({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        signal,
      }),
    );
  }
  @Get(':runId')
  @Header('Cache-Control', 'private, no-store')
  get(@Req() request: Request, @Param() params: unknown) {
    const route = workflowTestParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.tests.get({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        runId: route.runId,
        signal,
      }),
    );
  }
  @Post()
  @HttpCode(202)
  @RateLimit('preview_test')
  @UseGuards(CsrfProtectionGuard)
  start(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowIdParamSchema.parse(params);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.tests.start({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
  @Post(':runId/cancel')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(CsrfProtectionGuard)
  cancel(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    workflowTestCancelRequestSchema.parse(body);
    const route = workflowTestParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.tests.cancel({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        runId: route.runId,
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
