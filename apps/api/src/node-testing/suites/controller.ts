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
  workflowIdParamSchema,
  workflowTestSuiteParamsSchema,
  workflowTestSuiteCaseParamsSchema,
  workflowTestCancelRequestSchema,
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
import { WorkflowTestSuitesUseCase } from './use-case.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { nodeTestingFailure } from '../../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(nodeTestingFailure))
@Controller(
  'v1/workspaces/:workspaceId/workflows/:workflowId/draft/test-suites',
)
@UseGuards(SessionAuthenticationGuard, NodeTestingUpdateGuard)
@RateLimit('authenticated_read')
export class WorkflowTestSuitesController {
  constructor(private readonly suites: WorkflowTestSuitesUseCase) {}
  @Get('prepare')
  @RateLimit('workflow_compile')
  @Header('Cache-Control', 'private, no-store')
  prepare(@Req() request: Request, @Param() params: unknown) {
    const route = workflowIdParamSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.suites.prepare({
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
      this.suites.list({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        signal,
      }),
    );
  }
  @Get(':suiteId')
  @Header('Cache-Control', 'private, no-store')
  get(@Req() request: Request, @Param() params: unknown) {
    const route = workflowTestSuiteParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.suites.get({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        suiteId: route.suiteId,
        signal,
      }),
    );
  }
  @Get(':suiteId/cases/:ordinal')
  @Header('Cache-Control', 'private, no-store')
  report(@Req() request: Request, @Param() params: unknown) {
    const route = workflowTestSuiteCaseParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.suites.report({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        suiteId: route.suiteId,
        ordinal: route.ordinal,
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
    const route = workflowIdParamSchema.parse(params),
      idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.suites.start({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        request: body,
        idempotencyKey,
        signal,
      }),
    );
  }
  @Post(':suiteId/cancel')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(CsrfProtectionGuard)
  cancel(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    workflowTestCancelRequestSchema.parse(body);
    const route = workflowTestSuiteParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.suites.cancel({
        ...context(request, route.workspaceId),
        workflowId: route.workflowId,
        suiteId: route.suiteId,
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
