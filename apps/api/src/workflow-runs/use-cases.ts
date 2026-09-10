import { createHash } from 'node:crypto';

import {
  workflowRunCancelResponseSchema,
  workflowRunResponseSchema,
  workflowRunStartResponseSchema,
  type WorkflowRunCancelResponse,
  type WorkflowRunResponse,
  type WorkflowRunStartResponse,
} from '@pertexo/contracts/workflow-runs';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';

import {
  authorizeWorkspaceOperation,
  type AuthorizationCapability,
  type WorkspaceAuthorizationSource,
  type WorkspaceStatus,
} from '../workspaces/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunEventFrame,
  WorkflowRunEventStreamer,
  WorkflowRunPersistence,
  WorkflowRunReadModel,
  WorkflowRunRecord,
} from './ports.js';
import {
  createStreamAuthorizationLifetime,
  nextFrameOrAuthorizationLoss,
  type StreamAuthorizationLifetime,
} from './sse-authorization-lifetime.js';

export class WorkflowRunNotFoundError extends Error {
  public override readonly name = 'WorkflowRunNotFoundError';
}

export type StartWorkflowRunInput = WorkflowRunApplicationInput &
  Readonly<{
    workflowId: string;
    idempotencyKey: string;
    input?: unknown;
    deadlineAt?: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type ReplayWorkflowRunInput = WorkflowRunApplicationInput &
  Readonly<{
    runId: string;
    workflowVersionId: string;
    idempotencyKey: string;
    input: unknown;
    deadlineAt?: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type GetWorkflowRunInput = WorkflowRunApplicationInput &
  Readonly<{ runId: string }>;

export type CancelWorkflowRunInput = GetWorkflowRunInput &
  Readonly<{
    reason?: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export type StreamRunEventsInput = GetWorkflowRunInput &
  Readonly<{
    lastEventId: number;
    sessionExpiresAt: Date;
    reauthorizeSession: (signal: AbortSignal) => Promise<
      Readonly<{
        userId: string;
        sessionId: string;
        expiresAt: Date;
      }>
    >;
    abortStream(reason?: unknown): void;
    signal: AbortSignal;
  }>;

/** Maximum time an open stream may rely on a previously verified access fact. */
const SSE_REAUTHORIZATION_INTERVAL_MS = 5_000;

export class StartWorkflowRunUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'start'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: StartWorkflowRunInput,
  ): Promise<WorkflowRunStartResponse> {
    await authorize(input, 'run:start', this.authorization, ['active']);
    const deadlineAt =
      input.deadlineAt === undefined ? undefined : new Date(input.deadlineAt);
    if (deadlineAt !== undefined && Number.isNaN(deadlineAt.getTime())) {
      throw new TypeError('workflow run deadline is invalid');
    }
    const result = await this.persistence.start({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      idempotencyKeyHash: sha256(input.idempotencyKey),
      requestHash: startRequestHash(input),
      scope: `workflow:${input.workflowId}:manual`,
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...requestIdentifiers(input),
    });
    return toStartResponse(result);
  }
}

export class ReplayWorkflowRunUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'replay'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: ReplayWorkflowRunInput,
  ): Promise<WorkflowRunStartResponse> {
    await authorize(input, 'run:replay', this.authorization, ['active']);
    const deadlineAt =
      input.deadlineAt === undefined ? undefined : new Date(input.deadlineAt);
    if (deadlineAt !== undefined && Number.isNaN(deadlineAt.getTime())) {
      throw new TypeError('workflow run deadline is invalid');
    }
    const result = await this.persistence.replay({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      sourceRunId: input.runId,
      workflowVersionId: input.workflowVersionId,
      idempotencyKeyHash: sha256(input.idempotencyKey),
      requestHash: replayRequestHash(input),
      scope: `workflow:${input.runId}:replay`,
      input: input.input,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      ...requestIdentifiers(input),
    });
    return toStartResponse(result);
  }
}

export class GetWorkflowRunUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'get'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: GetWorkflowRunInput,
  ): Promise<WorkflowRunResponse> {
    await authorize(input, 'run:read', this.authorization, [
      'active',
      'suspended',
      'pending_deletion',
    ]);
    const result = await this.persistence.get({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
    });
    if (result === undefined) throw new WorkflowRunNotFoundError();
    return toRunResponse(result);
  }
}

export class CancelWorkflowRunUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'cancel'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: CancelWorkflowRunInput,
  ): Promise<WorkflowRunCancelResponse> {
    await authorize(input, 'run:cancel', this.authorization, [
      'active',
      'suspended',
      'pending_deletion',
    ]);
    const result = await this.persistence.cancel({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.requestId === undefined
        ? { requestId: input.actor.requestId }
        : { requestId: input.requestId }),
      ...(input.traceId === undefined && input.actor.traceId === undefined
        ? {}
        : { traceId: input.traceId ?? input.actor.traceId }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    });
    return workflowRunCancelResponseSchema.parse({
      run: toRunSummary(result.run),
      alreadyRequested: result.alreadyRequested,
    });
  }
}

export class StreamRunEventsUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'get'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly streamer: WorkflowRunEventStreamer,
  ) {}

  public async execute(
    input: StreamRunEventsInput,
  ): Promise<AsyncIterable<WorkflowRunEventFrame>> {
    await authorize(input, 'run:read', this.authorization, [
      'active',
      'suspended',
      'pending_deletion',
    ]);
    const run = await this.persistence.get({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
    });
    if (run === undefined) throw new WorkflowRunNotFoundError();
    const lifetimeController = new AbortController();
    const lifetimeSignal = AbortSignal.any([
      input.signal,
      lifetimeController.signal,
    ]);
    const frames = this.streamer.stream({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      lastEventId: input.lastEventId,
      signal: lifetimeSignal,
    });
    const authorizationLifetime = createStreamAuthorizationLifetime(
      { ...input, signal: lifetimeSignal },
      this.authorization,
      SSE_REAUTHORIZATION_INTERVAL_MS,
      lifetimeController,
    );
    return authorizedStreamFrames(
      frames,
      { ...input, signal: lifetimeSignal },
      lifetimeController,
      authorizationLifetime,
    );
  }
}

async function* authorizedStreamFrames(
  frames: AsyncIterable<WorkflowRunEventFrame>,
  input: StreamRunEventsInput,
  lifetimeController: AbortController,
  authorizationLifetime: StreamAuthorizationLifetime,
): AsyncGenerator<WorkflowRunEventFrame> {
  const iterator = frames[Symbol.asyncIterator]();
  try {
    while (!input.signal.aborted) {
      const outcome = await nextFrameOrAuthorizationLoss(
        iterator,
        authorizationLifetime.authorizationLost,
      );
      if (outcome.kind === 'authorization_lost') throw outcome.error;
      if (outcome.result.done === true) return;
      await authorizationLifetime.reauthorize();
      yield outcome.result.value;
    }
  } finally {
    // Authorization loss must cancel a pending producer read before awaiting
    // iterator cleanup. Otherwise an idle Redis/database read can keep the
    // authorization failure—and therefore the HTTP close—pending forever.
    lifetimeController.abort();
    await authorizationLifetime.stop();
    await iterator.return?.();
  }
}

async function authorize(
  input: WorkflowRunApplicationInput,
  capability: AuthorizationCapability,
  access: WorkspaceAuthorizationSource,
  allowedWorkspaceStatuses: readonly WorkspaceStatus[],
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses,
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}

function requestIdentifiers(
  input: Readonly<{
    actor: WorkflowRunApplicationInput['actor'];
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>,
): Readonly<{
  requestId: string;
  traceId?: string;
  traceparent?: string;
}> {
  return {
    requestId: input.requestId ?? input.actor.requestId,
    ...(input.traceId === undefined && input.actor.traceId === undefined
      ? {}
      : { traceId: input.traceId ?? input.actor.traceId }),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  };
}

function toStartResponse(
  result: Readonly<{ run: WorkflowRunRecord; replayed: boolean }>,
): WorkflowRunStartResponse {
  return workflowRunStartResponseSchema.parse({
    run: toRunSummary(result.run),
    replayed: result.replayed,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function startRequestHash(input: StartWorkflowRunInput): string {
  return sha256(
    canonicalJson({
      domain: 'pertexo.workflow-run.start-request',
      version: 1,
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
  );
}

function replayRequestHash(input: ReplayWorkflowRunInput): string {
  return sha256(
    canonicalJson({
      domain: 'pertexo.workflow-run.replay-request',
      version: 1,
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      sourceRunId: input.runId,
      workflowVersionId: input.workflowVersionId,
      input: input.input,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
  );
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toRunSummary(run: WorkflowRunRecord) {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    deadlineAt: iso(run.deadlineAt),
    cancelRequestedAt: iso(run.cancelRequestedAt),
  };
}

function toRunResponse(result: WorkflowRunReadModel): WorkflowRunResponse {
  return workflowRunResponseSchema.parse({
    run: toRunSummary(result.run),
    nodes: result.nodes.map((node) => ({
      ...node,
      startedAt: iso(node.startedAt),
      completedAt: iso(node.completedAt),
      resumeAt: iso(node.resumeAt),
    })),
  });
}
