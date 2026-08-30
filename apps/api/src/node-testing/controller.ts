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
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { createActorContext } from '../workspaces/index.js';
import { throwWorkflowApplicationError } from '../workflow-authoring/errors.js';
import { WorkflowUpdateGuard } from '../workflow-authoring/guards.js';
import { parseIdempotencyKey } from '../workflow-authoring/preconditions.js';
import type { WorkflowAuthoringRequest } from '../workflow-authoring/types.js';
import {
  NodeTestIdempotencyRequiredError,
  GetPreviewRunUseCase,
  TestWorkflowNodeUseCase,
} from './use-case.js';

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
  @UseGuards(SessionAuthenticationGuard, WorkflowUpdateGuard)
  public async status(
    @Req() request: WorkflowAuthoringRequest,
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
      return throwWorkflowApplicationError(error);
    }
  }

  @Post('workflows/:workflowId/draft/nodes/:nodeId/test')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async test(
    @Req() request: WorkflowAuthoringRequest,
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
      return throwWorkflowApplicationError(error);
    }
  }
}

function actorFrom(request: WorkflowAuthoringRequest, workspaceId: string) {
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

function requiredIdempotencyKey(request: WorkflowAuthoringRequest): string {
  const value = header(request, 'idempotency-key');
  if (value === undefined) throw new NodeTestIdempotencyRequiredError();
  return parseIdempotencyKey(value);
}

function singleHeader(
  request: WorkflowAuthoringRequest,
  name: string,
): string | undefined {
  const value = header(request, name);
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) {
    const first: unknown = value[0];
    if (typeof first === 'string') return first;
  }
  return undefined;
}

function header(request: WorkflowAuthoringRequest, name: string): unknown {
  const headers = request.headers;
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : headers[key];
}
