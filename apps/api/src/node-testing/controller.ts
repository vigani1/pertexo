import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  nodeTestParamsSchema,
  nodeTestRequestSchema,
  previewRunParamsSchema,
} from '@pertexo/contracts/node-testing';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { parseIdempotencyKey } from '../platform/http/index.js';
import {
  requestHeaderValue,
  singleRequestHeader,
} from '../platform/http/request-headers.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { createActorContext } from '../workspaces/index.js';
import {
  NodeTestIdempotencyRequiredError,
  throwNodeTestingApplicationError,
} from './errors.js';
import { NodeTestingUpdateGuard } from './guards.js';
import { GetPreviewRunUseCase, TestWorkflowNodeUseCase } from './use-case.js';

interface StatusResponse {
  status(code: number): unknown;
}

@Controller('v1/workspaces/:workspaceId')
@RateLimit('preview_test')
export class NodeTestingController {
  public constructor(
    private readonly testNode: TestWorkflowNodeUseCase,
    private readonly getPreview: GetPreviewRunUseCase,
  ) {}

  @Get('previews/:previewRunId')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, NodeTestingUpdateGuard)
  public async status(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
  ) {
    try {
      const route = previewRunParamsSchema.parse(params);
      return await this.getPreview.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        previewRunId: route.previewRunId,
      });
    } catch (error: unknown) {
      return throwNodeTestingApplicationError(error);
    }
  }

  @Post('workflows/:workflowId/draft/nodes/:nodeId/test')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    NodeTestingUpdateGuard,
    CsrfProtectionGuard,
  )
  public async test(
    @Req() request: IdentityWorkspaceRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    try {
      const route = nodeTestParamsSchema.parse(params);
      const command = nodeTestRequestSchema.parse(body);
      const idempotencyKey =
        command.mode === 'test_execute'
          ? requiredIdempotencyKey(request)
          : undefined;
      const traceId = traceIdentifier(request);
      const traceparent = singleHeader(request, 'traceparent');
      const result = await this.testNode.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        nodeId: route.nodeId,
        request: command,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        requestId: requestIdentifier(request),
        ...(traceId === undefined ? {} : { traceId }),
        ...(traceparent === undefined ? {} : { traceparent }),
      });
      if (command.mode === 'test_execute') response.status(202);
      return result;
    } catch (error: unknown) {
      return throwNodeTestingApplicationError(error);
    }
  }
}

function actorFrom(request: IdentityWorkspaceRequest, workspaceId: string) {
  const session = authenticatedSession(request);
  const traceId = traceIdentifier(request);
  return createActorContext({
    actorId: session.userId,
    workspaceId,
    sessionId: session.sessionId,
    requestId: requestIdentifier(request),
    ...(traceId === undefined ? {} : { traceId }),
  });
}

function requiredIdempotencyKey(request: IdentityWorkspaceRequest): string {
  const value = requestHeaderValue(request.headers, 'idempotency-key');
  if (value === undefined) throw new NodeTestIdempotencyRequiredError();
  return parseIdempotencyKey(value);
}

function singleHeader(
  request: IdentityWorkspaceRequest,
  name: string,
): string | undefined {
  return singleRequestHeader(request.headers, name);
}
