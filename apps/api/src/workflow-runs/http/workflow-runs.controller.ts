import { throwApplicationError } from '../../platform/http/application-error.js';
import {
  Controller,
  Inject,
  Optional,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  workflowRunRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import type { FastifyReply } from 'fastify';

import { singleRequestHeader } from '../../platform/http/request-headers.js';
import { In, Route } from '../../workspaces/http/route.js';

import { authenticatedSession } from '../../workspaces/index.js';
import { authenticatedRequestIdentifiers } from '../../workspaces/request/authenticated-context.js';
import { caller, type WorkflowRunsRequest } from './request-context.js';
import { applicationError } from '../../platform/http/index.js';
import { ApiDrainState } from '../../platform/health/drain-state.js';
import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRICS,
  type SseVisibilityMetrics,
  type SseVisibilityPath,
} from '../../platform/observability/sse-visibility-metrics.js';
import { prepareSseResponse } from '../../platform/http/sse-response.js';
import { GetWorkflowRunStatisticsUseCase } from '../statistics.js';
import { streamCleanupCompletion } from '../events/stream-cleanup.js';
import { writeSseFrames } from '../events/sse-transport.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  ListWorkflowRunsUseCase,
  ReplayWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from '../workflow-runs.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize-context-errors.js';

@UseInterceptors(domainErrors(runFailure))
@Controller()
export class WorkflowRunsController {
  // Nest resolves these dependencies positionally; grouping them would change DI.
  // eslint-disable-next-line max-params
  public constructor(
    private readonly startWorkflowRun: StartWorkflowRunUseCase,
    private readonly replayWorkflowRun: ReplayWorkflowRunUseCase,
    private readonly getWorkflowRun: GetWorkflowRunUseCase,
    private readonly listWorkflowRuns: ListWorkflowRunsUseCase,
    private readonly getWorkflowRunStatistics: GetWorkflowRunStatisticsUseCase,
    private readonly streamEvents: StreamRunEventsUseCase,
    private readonly cancelWorkflowRun: CancelWorkflowRunUseCase,
    @Optional()
    @Inject(SSE_VISIBILITY_METRICS)
    private readonly visibilityMetrics: SseVisibilityMetrics = createSseVisibilityMetrics(),
    @Optional()
    private readonly drainState: ApiDrainState = new ApiDrainState(),
  ) {}

  @Route(routes.start)
  public async startRun(
    @Req() request: WorkflowRunsRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.start>,
  ) {
    return this.startWorkflowRun.execute({
      ...caller(request, params),
      workflowId: params.workflowId,
      idempotencyKey,
      ...(body.expectedPublishedVersionId === undefined
        ? {}
        : { expectedPublishedVersionId: body.expectedPublishedVersionId }),
      ...(body.input === undefined ? {} : { input: body.input }),
      ...(body.deadlineAt === undefined ? {} : { deadlineAt: body.deadlineAt }),
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }

  @Route(routes.replay)
  public async replayRun(
    @Req() request: WorkflowRunsRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.replay>,
  ) {
    return this.replayWorkflowRun.execute({
      ...caller(request, params),
      runId: params.runId,
      workflowVersionId: body.workflowVersionId,
      input: body.input,
      ...(body.deadlineAt === undefined ? {} : { deadlineAt: body.deadlineAt }),
      idempotencyKey,
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }

  @Route(routes.get)
  public async getRun(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.get>,
  ) {
    return this.getWorkflowRun.execute({
      ...caller(request, params),
      runId: params.runId,
    });
  }

  @Route(routes.list)
  public async listRuns(
    @Req() request: WorkflowRunsRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return this.listWorkflowRuns.execute({
      ...caller(request, params),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.runValueKey === undefined
        ? {}
        : {
            runValueKey: query.runValueKey,
            ...(query.runValue === undefined
              ? {}
              : { runValue: query.runValue }),
          }),
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.workflowId === undefined
        ? {}
        : { workflowId: query.workflowId }),
      ...(query.workflowNamePrefix === undefined
        ? {}
        : { workflowNamePrefix: query.workflowNamePrefix }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.createdAtFrom === undefined
        ? {}
        : { createdAtFrom: query.createdAtFrom }),
      ...(query.createdAtBefore === undefined
        ? {}
        : { createdAtBefore: query.createdAtBefore }),
    });
  }

  @Route(routes.statistics)
  public async getRunStatistics(
    @Req() request: WorkflowRunsRequest,
    @In() { params, query }: RouteInput<typeof routes.statistics>,
  ) {
    return this.getWorkflowRunStatistics.execute({
      ...caller(request, params),
      ...(query.window === undefined ? {} : { window: query.window }),
      ...(query.breakdown === undefined ? {} : { breakdown: query.breakdown }),
    });
  }

  @Route(routes.events)
  public async streamRunEvents(
    @Req() request: WorkflowRunsRequest,
    @In() { params, headers }: RouteInput<typeof routes.events>,
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
      const requestedLastEventId = Number(headers['last-event-id'] ?? 0);
      const frames = await this.streamEvents.execute({
        ...caller(request, params),
        runId: params.runId,
        lastEventId: requestedLastEventId,
        sessionExpiresAt: authenticatedSession(request).expiresAt,
        reauthorizeSession: sessionReauthorization(request),
        abortStream: (reason?: unknown) => {
          controller.abort(reason);
        },
        signal: controller.signal,
      });
      prepareSseResponse(reply);
      await writeSseFrames(frames, reply.raw, {
        controller: controller,
        visibilityMetrics: this.visibilityMetrics,
        fallbackPath: routeLastEventPath(requestedLastEventId),
      });
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

  @Route(routes.cancel)
  public async cancelRun(
    @Req() request: WorkflowRunsRequest,
    @In() { params, body }: RouteInput<typeof routes.cancel>,
  ) {
    return this.cancelWorkflowRun.execute({
      ...caller(request, params),
      runId: params.runId,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...requestIdentifiers(request),
      ...traceparent(request),
    });
  }
}

function routeLastEventPath(lastEventId: number): SseVisibilityPath {
  return lastEventId === 0 ? 'initial_backfill' : 'reconnect_backfill';
}

function sessionReauthorization(
  request: WorkflowRunsRequest,
): NonNullable<WorkflowRunsRequest['reauthorizeIdentitySession']> {
  if (request.reauthorizeIdentitySession === undefined) {
    return throwApplicationError(applicationError('auth.unauthenticated'));
  }
  return request.reauthorizeIdentitySession;
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
