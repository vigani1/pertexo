import { EMPTY_WORKFLOW_GRAPH } from '../graph.js';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';

import {
  WORKFLOW_AUTHORING_OPERATION,
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  type WorkflowAuthoringTelemetry,
} from '../telemetry.js';
import { workflowCreateRequestSchema } from '../types.js';
import type { WorkflowApplicationInput } from '../ports.js';

import {
  serializeWorkflowCreate,
  type WorkflowCreateResult,
} from '../http/serializers.js';

import { parseRequestBody } from '../../platform/http/index.js';
import { type AuthoringPersistence, authorize } from './authorization.js';

export type CreateWorkflowInput = WorkflowApplicationInput &
  Readonly<{
    request: unknown;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
  }>;

export class CreateWorkflowUseCase {
  public constructor(
    private readonly persistence: AuthoringPersistence<'createWorkflow'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(input: CreateWorkflowInput): Promise<WorkflowCreateResult> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.create,
      async () => {
        await authorize(input, 'workflow:create', this.authorization);
        const request = parseRequestBody(
          workflowCreateRequestSchema,
          input.request,
        );
        const created = await this.persistence.createWorkflow({
          workspaceId: input.routeWorkspaceId,
          actorId: input.actor.actorId,
          name: request.name,
          ...(request.folderId === undefined
            ? {}
            : { folderId: request.folderId }),
          emptyGraph: EMPTY_WORKFLOW_GRAPH,
          idempotencyKey: input.idempotencyKey,
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        });
        return serializeWorkflowCreate(created);
      },
    );
  }
}
