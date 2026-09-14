import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Optional,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  lastRunEventIdHeaderSchema,
  workflowRunCancelRequestSchema,
  workflowRunParamsSchema,
  workflowRunReplayRequestSchema,
  workflowRunStartParamsSchema,
  workflowRunStartRequestSchema,
} from '@pertexo/contracts/workflow-runs';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';
import type { FastifyReply } from 'fastify';

import {
  requestHeaderValue,
  singleRequestHeader,
} from '../platform/http/request-headers.js';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
} from '../identity-workspace/index.js';
import {
  authenticatedRequestIdentifiers,
  optionalAuthorizedWorkspace,
  projectAuthenticatedWorkspaceContext,
} from '../identity-workspace/authenticated-command-context.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { applicationError } from '../platform/http/index.js';
import { ApiDrainState } from '../platform/health/drain-state.js';
import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRICS,
  type SseVisibilityMetrics,
  type SseVisibilityPath,
} from '../platform/observability/sse-visibility-metrics.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { throwWorkflowRunError } from './errors.js';
import {
  WorkflowRunCancelGuard,
  WorkflowRunReplayGuard,
  WorkflowRunReadGuard,
  WorkflowRunStartGuard,
} from './guards.js';
import { streamCleanupCompletion } from './stream-cleanup.js';
import { writeSseFrames } from './sse-transport.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from './use-cases.js';

export type WorkflowRunsRequest = Readonly<
  Pick<
    IdentityWorkspaceRequest,
    | 'authorizedWorkspace'
    | 'cookies'
    | 'headers'
    | 'identitySession'
    | 'method'
    | 'reauthorizeIdentitySession'
    | 'requestId'
    | 'traceId'
  > & {
    raw?: Readonly<{
      once(event: 'close', listener: () => void): unknown;
      off(event: 'close', listener: () => void): unknown;
    }>;
  }
>;

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowRunsController {
  public constructor(
    private readonly startWorkflowRun: StartWorkflowRunUseCase,
    private readonly replayWorkflowRun: ReplayWorkflowRunUseCase,
    private readonly getWorkflowRun: GetWorkflowRunUseCase,
    private readonly streamEvents: StreamRunEventsUseCase,
    private readonly cancelWorkflowRun: CancelWorkflowRunUseCase,
    @Optional()
    @Inject(SSE_VISIBILITY_METRICS)
    private readonly visibilityMetrics: SseVisibilityMetrics = createSseVisibilityMetrics(),
    @Optional()
    private readonly drainState: ApiDrainState = new ApiDrainState(),
  ) {}

  @Post('workflows/:workflowId/runs')
  @RateLimit('run_admission')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowRunStartGuard,
    CsrfProtectionGuard,
  )
  public async startRun(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowRunStartParamsSchema.parse(params);
    const input = workflowRunStartRequestSchema.parse(body);
    return this.startWorkflowRun.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      workflowId: route.workflowId,
      idempotencyKey: requiredIdempotencyKey(request),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }

  @Post('runs/:runId/replay')
  @RateLimit('run_admission')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowRunReplayGuard,
    CsrfProtectionGuard,
  )
  public async replayRun(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    const input = workflowRunReplayRequestSchema.parse(body);
    return this.replayWorkflowRun.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      runId: route.runId,
      workflowVersionId: input.workflowVersionId,
      input: input.input,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
      idempotencyKey: requiredIdempotencyKey(request),
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }

  @Get('runs/:runId')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getRun(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    return this.getWorkflowRun.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      runId: route.runId,
    });
  }

  @Get('runs/:runId/events')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async streamRunEvents(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const controller = new AbortController();
    const onClose = (): void => {
      controller.abort();
    };
    request.raw?.once('close', onClose);
    const releaseDrainRegistration = this.drainState.registerStream(controller);
    let releaseAfterCleanup: Promise<void> | undefined;
    try {
      const route = workflowRunParamsSchema.parse(params);
      const requestedLastEventId = lastEventId(request);
      const frames = await this.streamEvents.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...guardAuthorization(request),
        runId: route.runId,
        lastEventId: requestedLastEventId,
        sessionExpiresAt: authenticatedSession(request).expiresAt,
        reauthorizeSession: sessionReauthorization(request),
        abortStream: (reason?: unknown) => {
          controller.abort(reason);
        },
        signal: controller.signal,
      });
      prepareSseResponse(reply);
      await writeSseFrames(
        frames,
        reply.raw,
        controller,
        this.visibilityMetrics,
        routeLastEventPath(requestedLastEventId),
      );
    } catch (error: unknown) {
      controller.abort();
      releaseAfterCleanup = streamCleanupCompletion(error);
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      throw error;
    } finally {
      request.raw?.off('close', onClose);
      if (releaseAfterCleanup === undefined) releaseDrainRegistration();
      else void releaseAfterCleanup.then(releaseDrainRegistration);
    }
  }

  @Post('runs/:runId/cancel')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowRunCancelGuard,
    CsrfProtectionGuard,
  )
  public async cancelRun(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    const input = workflowRunCancelRequestSchema.parse(body);
    return this.cancelWorkflowRun.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      runId: route.runId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }
}

function guardAuthorization(
  request: WorkflowRunsRequest,
): Pick<WorkflowRunsRequest, 'authorizedWorkspace'> {
  return optionalAuthorizedWorkspace(request);
}

function prepareSseResponse(reply: FastifyReply): void {
  reply.raw.statusCode = 200;
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader(
    'Cache-Control',
    'private, no-cache, no-store, must-revalidate, max-age=0',
  );
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.hijack();
  reply.raw.flushHeaders();
}

function routeLastEventPath(lastEventId: number): SseVisibilityPath {
  return lastEventId === 0 ? 'initial_backfill' : 'reconnect_backfill';
}

function sessionReauthorization(
  request: WorkflowRunsRequest,
): NonNullable<WorkflowRunsRequest['reauthorizeIdentitySession']> {
  if (request.reauthorizeIdentitySession === undefined) {
    return throwWorkflowRunError(applicationError('auth.unauthenticated'));
  }
  return request.reauthorizeIdentitySession;
}

function requiredIdempotencyKey(request: WorkflowRunsRequest): string {
  const raw = requestHeaderValue(request.headers, 'idempotency-key');
  if (raw === undefined)
    return throwWorkflowRunError(
      applicationError('request.precondition_required', {
        safeDetail: 'Idempotency-Key is required for this operation.',
      }),
    );
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success)
    return throwWorkflowRunError(
      applicationError('request.invalid', {
        safeDetail: 'Idempotency-Key must contain exactly one valid value.',
      }),
    );
  return parsed.data;
}

function lastEventId(request: WorkflowRunsRequest): number {
  const value = singleRequestHeader(request.headers, 'last-event-id');
  if (value === undefined) return 0;
  return Number(lastRunEventIdHeaderSchema.parse(value));
}

function actorFrom(request: WorkflowRunsRequest, workspaceId: string) {
  try {
    return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
  } catch (error: unknown) {
    return throwWorkflowRunError(
      applicationError('request.invalid', {
        safeDetail:
          error instanceof Error ? error.message : 'Invalid actor context',
      }),
    );
  }
}

function requestIdentifiers(request: WorkflowRunsRequest): Readonly<{
  requestId: string;
  traceId?: string;
}> {
  return authenticatedRequestIdentifiers(request);
}

function traceparent(
  request: WorkflowRunsRequest,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined ? {} : { traceparent: value };
}
