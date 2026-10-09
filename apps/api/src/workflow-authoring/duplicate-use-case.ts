import {
  workflowDuplicateRequestSchema,
  workflowDuplicateResponseSchema,
  type WorkflowDuplicateResponse,
} from '@pertexo/contracts';
import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type {
  WorkflowApplicationInput,
  WorkflowAuthoringPersistence,
} from './ports.js';
import { parseStrongIfMatch } from './preconditions.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from './telemetry.js';

export type DuplicateWorkflowInput = WorkflowApplicationInput &
  Readonly<{
    workflowId: string;
    request: unknown;
    representationTag?: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }>;

/** Source selection and destination creation remain one authoritative transaction. */
export class DuplicateWorkflowUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowAuthoringPersistence,
      'duplicateWorkflow'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: DuplicateWorkflowInput,
  ): Promise<WorkflowDuplicateResponse> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.duplicate,
      async () => {
        const authority = {
          actor: input.actor,
          routeWorkspaceId: input.routeWorkspaceId,
          access: this.authorization,
          disclosure: 'not_found' as const,
          allowedWorkspaceStatuses: ['active'] as const,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        };
        // Source read and destination create are distinct capability proofs.
        await authorizeWorkspaceOperation({
          ...authority,
          capability: 'workflow:read',
          ...(input.authorizedWorkspace?.capability === 'workflow:read'
            ? { authorizedWorkspace: input.authorizedWorkspace }
            : {}),
        });
        await authorizeWorkspaceOperation({
          ...authority,
          capability: 'workflow:create',
          ...(input.authorizedWorkspace?.capability === 'workflow:create'
            ? { authorizedWorkspace: input.authorizedWorkspace }
            : {}),
        });
        const { name, source } = workflowDuplicateRequestSchema.parse(
          input.request,
        );
        const representationTag =
          source.kind === 'draft'
            ? parseStrongIfMatch(input.representationTag)
            : undefined;
        return workflowDuplicateResponseSchema.parse(
          await this.persistence.duplicateWorkflow({
            workspaceId: input.routeWorkspaceId,
            workflowId: input.workflowId,
            actorId: input.actor.actorId,
            name,
            source,
            idempotencyKey: input.idempotencyKey,
            requestId: input.actor.requestId,
            ...(representationTag === undefined ? {} : { representationTag }),
            ...(input.actor.traceId === undefined
              ? {}
              : { traceId: input.actor.traceId }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
        );
      },
    );
  }
}
