import {
  type WorkflowRecoveryRequest,
  workflowRecoveryPreviewSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
} from '../ports.js';
import { sha256 } from '../http/request-hashes.js';

export type RecoveryPreviewInput = WorkflowRunApplicationInput &
  Readonly<{ runId: string }>;
export type RecoverRunInput = RecoveryPreviewInput &
  WorkflowRecoveryRequest &
  Readonly<{
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

async function authorize(
  input: WorkflowRunApplicationInput,
  authorization: WorkspaceAuthorizationSource,
) {
  await authorizeWorkspaceOperation({
    ...input,
    capability: 'run:replay',
    allowedWorkspaceStatuses: ['active'],
    disclosure: 'not_found',
    access: authorization,
  });
}

export class GetRunRecoveryUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'recovery'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  public async execute(input: RecoveryPreviewInput) {
    await authorize(input, this.authorization);
    return workflowRecoveryPreviewSchema.parse(
      await this.persistence.recovery({
        workspaceId: input.routeWorkspaceId,
        runId: input.runId,
      }),
    );
  }
}

export function recoveryRequestHash(input: RecoverRunInput): string {
  return sha256(
    canonicalJson({
      domain: 'pertexo.workflow-run.recover-request',
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      sourceRunId: input.runId,
      workflowVersionId: input.workflowVersionId,
      nodeRunId: input.nodeRunId,
      acknowledgePossibleEffects: input.acknowledgePossibleEffects === true,
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: input.deadlineAt }),
    }),
  );
}

export class RecoverRunUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'recover'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  public async execute(input: RecoverRunInput) {
    await authorize(input, this.authorization);
    const result = await this.persistence.recover({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      sourceRunId: input.runId,
      workflowVersionId: input.workflowVersionId,
      nodeRunId: input.nodeRunId,
      scope: `workflow:${input.runId}:recover`,
      idempotencyKeyHash: sha256(input.idempotencyKey),
      requestHash: recoveryRequestHash(input),
      ...(input.acknowledgePossibleEffects === undefined
        ? {}
        : { acknowledgePossibleEffects: input.acknowledgePossibleEffects }),
      ...(input.deadlineAt === undefined
        ? {}
        : { deadlineAt: new Date(input.deadlineAt) }),
      requestId: input.requestId ?? input.actor.requestId,
      ...(input.traceId === undefined && input.actor.traceId === undefined
        ? {}
        : { traceId: input.traceId ?? input.actor.traceId }),
      ...(input.traceparent === undefined
        ? {}
        : { traceparent: input.traceparent }),
    });
    const run = result.run;
    return workflowRunStartResponseSchema.parse({
      replayed: result.replayed,
      run: {
        ...run,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        deadlineAt: run.deadlineAt?.toISOString() ?? null,
        cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
      },
    });
  }
}
