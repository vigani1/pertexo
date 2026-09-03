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
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import {
  lastRunEventIdHeaderSchema,
  workflowRunCancelRequestSchema,
  workflowRunEventSchema,
  workflowRunParamsSchema,
  workflowRunStartParamsSchema,
  workflowRunStartRequestSchema,
} from '@pertexo/contracts/workflow-runs';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';
import { Observable } from 'rxjs';

import {
  requestHeaderValue,
  singleRequestHeader,
} from '../platform/http/request-headers.js';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { applicationError } from '../platform/http/index.js';
import {
  createSseVisibilityMetrics,
  SSE_VISIBILITY_METRICS,
  type SseVisibilityMetrics,
  type SseVisibilityPath,
} from '../platform/observability/sse-visibility-metrics.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { createActorContext } from '../workspaces/index.js';
import type { AuthorizedWorkspaceContext } from '../workspaces/index.js';
import { throwWorkflowRunError } from './errors.js';
import {
  WorkflowRunCancelGuard,
  WorkflowRunReadGuard,
  WorkflowRunStartGuard,
} from './guards.js';
import type { WorkflowRunEventFrame } from './ports.js';
import {
  CancelWorkflowRunUseCase,
  GetWorkflowRunUseCase,
  StartWorkflowRunUseCase,
  StreamRunEventsUseCase,
} from './use-cases.js';

export type WorkflowRunsRequest = Readonly<{
  method?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  cookies?: Readonly<Record<string, string | undefined>>;
  requestId?: string;
  traceId?: string;
  identitySession?: Readonly<{
    userId: string;
    sessionId: string;
    expiresAt: Date;
    clientMetadata: Readonly<Record<string, string>>;
  }>;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  raw?: Readonly<{
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  }>;
}>;

@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowRunsController {
  public constructor(
    private readonly startWorkflowRun: StartWorkflowRunUseCase,
    private readonly getWorkflowRun: GetWorkflowRunUseCase,
    private readonly streamEvents: StreamRunEventsUseCase,
    private readonly cancelWorkflowRun: CancelWorkflowRunUseCase,
    @Optional()
    @Inject(SSE_VISIBILITY_METRICS)
    private readonly visibilityMetrics: SseVisibilityMetrics = createSseVisibilityMetrics(),
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
    try {
      const route = workflowRunStartParamsSchema.parse(params);
      const input = workflowRunStartRequestSchema.parse(body);
      return await this.startWorkflowRun.execute({
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
    } catch (error: unknown) {
      return throwWorkflowRunError(error);
    }
  }

  @Get('runs/:runId')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getRun(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    try {
      const route = workflowRunParamsSchema.parse(params);
      return await this.getWorkflowRun.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...guardAuthorization(request),
        runId: route.runId,
      });
    } catch (error: unknown) {
      return throwWorkflowRunError(error);
    }
  }

  @Sse('runs/:runId/events')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async streamRunEvents(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ): Promise<Observable<MessageEvent>> {
    const controller = new AbortController();
    const onClose = (): void => {
      controller.abort();
    };
    request.raw?.once('close', onClose);
    try {
      const route = workflowRunParamsSchema.parse(params);
      const requestedLastEventId = lastEventId(request);
      const frames = await this.streamEvents.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...guardAuthorization(request),
        runId: route.runId,
        lastEventId: requestedLastEventId,
        signal: controller.signal,
      });
      return frameObservable(
        frames,
        controller,
        () => {
          request.raw?.off('close', onClose);
        },
        this.visibilityMetrics,
        routeLastEventPath(requestedLastEventId),
      );
    } catch (error: unknown) {
      request.raw?.off('close', onClose);
      controller.abort();
      return throwWorkflowRunError(error);
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
    try {
      const route = workflowRunParamsSchema.parse(params);
      const input = workflowRunCancelRequestSchema.parse(body);
      return await this.cancelWorkflowRun.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...guardAuthorization(request),
        runId: route.runId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...requestIdentifiers(request),
        ...traceparent(request),
      });
    } catch (error: unknown) {
      return throwWorkflowRunError(error);
    }
  }
}

function guardAuthorization(
  request: WorkflowRunsRequest,
): Pick<WorkflowRunsRequest, 'authorizedWorkspace'> {
  return request.authorizedWorkspace === undefined
    ? {}
    : { authorizedWorkspace: request.authorizedWorkspace };
}

function frameObservable(
  frames: AsyncIterable<WorkflowRunEventFrame>,
  controller: AbortController,
  detach: () => unknown,
  visibilityMetrics: SseVisibilityMetrics,
  fallbackPath: SseVisibilityPath,
): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    const iterator = frames[Symbol.asyncIterator]();
    const emittedSequences = new Set<number>();
    void (async (): Promise<void> => {
      try {
        while (!controller.signal.aborted) {
          const next = await iterator.next();
          if (next.done === true) break;
          const event = workflowRunEventSchema.parse(
            JSON.parse(next.value.data),
          );
          if (subscriber.closed) break;
          subscriber.next({
            id: String(next.value.id),
            type: next.value.event,
            data: event,
          });
          if (!emittedSequences.has(event.sequence)) {
            emittedSequences.add(event.sequence);
            visibilityMetrics.recordFirstEligibleFrame({
              createdAt: new Date(event.createdAt),
              path: next.value.visibilityPath ?? fallbackPath,
            });
          }
        }
        subscriber.complete();
      } catch (error: unknown) {
        subscriber.error(error);
      } finally {
        detach();
      }
    })();
    return () => {
      controller.abort();
      detach();
      void iterator.return?.();
    };
  });
}

function routeLastEventPath(lastEventId: number): SseVisibilityPath {
  return lastEventId === 0 ? 'initial_backfill' : 'reconnect_backfill';
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
  if (request.authorizedWorkspace !== undefined)
    return request.authorizedWorkspace.actor;
  const session = authenticatedSession(request);
  const traceId = traceIdentifier(request);
  try {
    return createActorContext({
      actorId: session.userId,
      workspaceId,
      sessionId: session.sessionId,
      requestId: requestIdentifier(request),
      ...(traceId === undefined ? {} : { traceId }),
    });
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
  if (request.authorizedWorkspace !== undefined) {
    const actor = request.authorizedWorkspace.actor;
    return {
      requestId: actor.requestId,
      ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
    };
  }
  const requestId = requestIdentifier(request);
  const traceId = traceIdentifier(request);
  return {
    requestId,
    ...(traceId === undefined ? {} : { traceId }),
  };
}

function traceparent(
  request: WorkflowRunsRequest,
): Readonly<{ traceparent?: string }> {
  const value = singleRequestHeader(request.headers, 'traceparent');
  return value === undefined ? {} : { traceparent: value };
}
