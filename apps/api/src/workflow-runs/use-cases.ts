import {
  workflowRunCancelResponseSchema,
  normalizeWorkflowRunCreatedAt,
  workflowRunListResponseSchema,
  workflowRunResponseSchema,
  workflowRunStartResponseSchema,
  type WorkflowRunCancelResponse,
  type WorkflowRunListResponse,
  type WorkflowRunResponse,
  type WorkflowRunStartResponse,
} from '@pertexo/contracts';
import {
  commandIdempotencyScope,
  credentialAllowsCapability,
  hasCapability,
  type WorkspaceAuthorizationSource,
} from '../authorization/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
  WorkflowRunReadModel,
  WorkflowRunRecord,
} from './ports.js';
import {
  decodeWorkflowRunCursor,
  encodeWorkflowRunCursor,
  type WorkflowRunCursorContext,
} from './cursor.js';

import {
  replayRequestHash,
  sha256,
  startRequestHash,
} from './http/request-hashes.js';
import type {
  StartWorkflowRunInput,
  ReplayWorkflowRunInput,
  GetWorkflowRunInput,
  ListWorkflowRunsInput,
  CancelWorkflowRunInput,
} from './access/contract.js';
import { WorkflowRunNotFoundError, authorize } from './access/authorize.js';

export {
  type StartWorkflowRunInput,
  type ReplayWorkflowRunInput,
  type GetWorkflowRunInput,
  type ListWorkflowRunsInput,
  type CancelWorkflowRunInput,
  type StreamRunEventsInput,
} from './access/contract.js';
export { WorkflowRunNotFoundError } from './access/authorize.js';
export { StreamRunEventsUseCase } from './events/authorized.js';
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
    const result = await this.persistence.start({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      idempotencyKeyHash: sha256(input.idempotencyKey),
      requestHash: startRequestHash(input),
      scope: commandIdempotencyScope(
        input.actor,
        `workflow:${input.workflowId}:manual`,
      ),
      ...(input.expectedPublishedVersionId === undefined
        ? {}
        : { expectedPublishedVersionId: input.expectedPublishedVersionId }),
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
    const authorization = await authorize(
      input,
      'run:read',
      this.authorization,
      ['active', 'suspended', 'pending_deletion'],
    );
    const result = await this.persistence.get({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      includeWorkflowName:
        credentialAllowsCapability(input.actor, 'workflow:read') &&
        hasCapability(authorization.role, 'workflow:read'),
    });
    if (result === undefined) throw new WorkflowRunNotFoundError();
    return toRunResponse(result);
  }
}

export class ListWorkflowRunsUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'list'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: ListWorkflowRunsInput,
  ): Promise<WorkflowRunListResponse> {
    const authorization = await authorize(
      input,
      'run:read',
      this.authorization,
      ['active', 'suspended', 'pending_deletion'],
    );
    const context = normalizedCursorContext(input);
    const includeWorkflowName =
      credentialAllowsCapability(input.actor, 'workflow:read') &&
      hasCapability(authorization.role, 'workflow:read');
    if (context.workflowNamePrefix !== undefined && !includeWorkflowName) {
      throw new WorkflowRunNotFoundError();
    }
    const page = await this.persistence.list({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      limit: input.limit ?? 50,
      includeWorkflowName,
      ...(context.runValueKey === undefined
        ? {}
        : {
            runValueKey: context.runValueKey,
            ...(context.runValue === undefined
              ? {}
              : { runValue: context.runValue }),
          }),
      ...(context.workflowId === undefined
        ? {}
        : { workflowId: context.workflowId }),
      ...(context.workflowNamePrefix === undefined
        ? {}
        : { workflowNamePrefix: context.workflowNamePrefix }),
      ...(context.status === undefined ? {} : { status: context.status }),
      ...(context.createdAtFrom === undefined
        ? {}
        : { createdAtFrom: context.createdAtFrom }),
      ...(context.createdAtBefore === undefined
        ? {}
        : { createdAtBefore: context.createdAtBefore }),
      ...(input.after === undefined
        ? {}
        : { after: decodeWorkflowRunCursor(input.after, context) }),
    });
    return workflowRunListResponseSchema.parse({
      items: page.items.map(toRunSummary),
      nextCursor:
        page.nextCursor === undefined
          ? null
          : encodeWorkflowRunCursor(context, page.nextCursor),
    });
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
      ...requestIdentifiers(input),
    });
    return workflowRunCancelResponseSchema.parse({
      run: toRunSummary(result.run),
      alreadyRequested: result.alreadyRequested,
    });
  }
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

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function normalizedCursorContext(
  input: ListWorkflowRunsInput,
): WorkflowRunCursorContext {
  return {
    workspaceId: input.routeWorkspaceId,
    ...(input.runValueKey === undefined
      ? {}
      : {
          runValueKey: input.runValueKey,
          ...(input.runValue === undefined ? {} : { runValue: input.runValue }),
        }),
    ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
    ...(input.workflowNamePrefix === undefined
      ? {}
      : { workflowNamePrefix: input.workflowNamePrefix.trim() }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.createdAtFrom === undefined
      ? {}
      : { createdAtFrom: normalizeWorkflowRunCreatedAt(input.createdAtFrom) }),
    ...(input.createdAtBefore === undefined
      ? {}
      : {
          createdAtBefore: normalizeWorkflowRunCreatedAt(input.createdAtBefore),
        }),
  };
}

function toRunSummary(
  run: WorkflowRunRecord & Readonly<{ workflowName?: string | null }>,
) {
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
    ...(result.calls === undefined ? {} : { calls: result.calls }),
    ...(result.errorWorkflow === undefined
      ? {}
      : { errorWorkflow: result.errorWorkflow }),
    ...(result.parentCall === undefined
      ? {}
      : { parentCall: result.parentCall }),
    nodes: result.nodes.map((node) => ({
      ...node,
      startedAt: iso(node.startedAt),
      completedAt: iso(node.completedAt),
      resumeAt: iso(node.resumeAt),
    })),
  });
}
