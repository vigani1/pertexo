import {
  workflowLifecycleRequestSchema,
  workflowLifecycleResponseSchema,
  type WorkflowLifecycleResponse,
} from '@pertexo/contracts/workflow-authoring';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringPersistence,
} from './ports.js';
import { workflowSummary } from './serializers.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';

export type WorkflowLifecycleInput = WorkflowApplicationInput &
  Readonly<{
    command: 'archive' | 'restore';
    workflowId: string;
    request: unknown;
    idempotencyKey: string;
    traceparent?: string;
  }>;

/** Desired lifecycle is independent of draft edits and existing run execution. */
export class TransitionWorkflowLifecycleUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowAuthoringPersistence,
      'transitionWorkflowLifecycle'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: WorkflowLifecycleInput,
  ): Promise<WorkflowLifecycleResponse> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION[input.command],
      async () => {
        await authorizeWorkspaceOperation({
          actor: input.actor,
          routeWorkspaceId: input.routeWorkspaceId,
          capability: 'workflow:publish',
          access: this.authorization,
          disclosure: 'not_found',
          allowedWorkspaceStatuses: ['active'],
          ...(input.authorizedWorkspace === undefined
            ? {}
            : { authorizedWorkspace: input.authorizedWorkspace }),
        });
        const request = workflowLifecycleRequestSchema.parse(input.request);
        const accepted = await this.persistence.transitionWorkflowLifecycle({
          ...request,
          command: input.command,
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          actorId: input.actor.actorId,
          idempotencyKey: input.idempotencyKey,
          requestId: input.actor.requestId,
          ...(input.actor.traceId === undefined
            ? {}
            : { traceId: input.actor.traceId }),
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        });
        return workflowLifecycleResponseSchema.parse({
          workflow: workflowSummary(accepted.workflow),
          replayed: accepted.replayed,
        });
      },
    );
  }
}
