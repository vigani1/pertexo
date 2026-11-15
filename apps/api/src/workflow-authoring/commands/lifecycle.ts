import { commandContext } from '../../workspaces/request/caller.js';
import type { workflowLifecycleRequestSchema } from '@pertexo/contracts';
import type { WorkflowLifecycleResponse } from '@pertexo/contracts';
import type { z } from 'zod';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import { workflowSummary } from '../http/serializers.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringPersistence,
} from '../ports.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from '../telemetry.js';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';

export type WorkflowLifecycleInput = WorkflowApplicationInput &
  Readonly<{
    command: 'archive' | 'restore';
    workflowId: string;
    request: z.output<typeof workflowLifecycleRequestSchema>;
    idempotencyKey: string;
    traceparent?: string;
  }>;

/** Desired lifecycle is independent of draft edits and existing run execution. */
export class TransitionWorkflowLifecycleService {
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
          allowedWorkspaceStatuses: ACTIVE_WORKSPACE_STATUSES,
          ...(input.authorizedWorkspace === undefined
            ? {}
            : { authorizedWorkspace: input.authorizedWorkspace }),
        });
        const request = input.request;
        const accepted = await this.persistence.transitionWorkflowLifecycle({
          ...request,
          command: input.command,
          ...commandContext(input),
          workflowId: input.workflowId,
          idempotencyKey: input.idempotencyKey,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        });
        return {
          workflow: workflowSummary(accepted.workflow),
          replayed: accepted.replayed,
        };
      },
    );
  }
}
