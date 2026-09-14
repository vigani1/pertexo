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
} from '../identity-workspace/index.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { parseIdempotencyKey } from '../platform/http/index.js';
import {
  requestHeaderValue,
  singleRequestHeader,
} from '../platform/http/request-headers.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { NodeTestRequestError } from './errors.js';
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
    const route = previewRunParamsSchema.parse(params);
    const context = projectAuthenticatedWorkspaceContext(
      request,
      route.workspaceId,
    );
    return this.getPreview.execute({
      actor: context.actor,
      routeWorkspaceId: route.workspaceId,
      ...(context.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: context.authorizedWorkspace }),
      previewRunId: route.previewRunId,
    });
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
    const route = nodeTestParamsSchema.parse(params);
    const command = nodeTestRequestSchema.parse(body);
    const idempotencyKey =
      command.mode === 'test_execute'
        ? requiredIdempotencyKey(request)
        : undefined;
    const traceparent = singleHeader(request, 'traceparent');
    const context = projectAuthenticatedWorkspaceContext(
      request,
      route.workspaceId,
    );
    const result = await this.testNode.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      nodeId: route.nodeId,
      request: command,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(traceparent === undefined ? {} : { traceparent }),
    });
    if (command.mode === 'test_execute') response.status(202);
    return result;
  }
}

function requiredIdempotencyKey(request: IdentityWorkspaceRequest): string {
  const value = requestHeaderValue(request.headers, 'idempotency-key');
  if (value === undefined)
    throw new NodeTestRequestError('idempotency_required');
  return parseIdempotencyKey(value);
}

function singleHeader(
  request: IdentityWorkspaceRequest,
  name: string,
): string | undefined {
  return singleRequestHeader(request.headers, name);
}
