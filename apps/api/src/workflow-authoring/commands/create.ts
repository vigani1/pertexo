import type { z } from 'zod';
import type { WorkspaceAuthorizationSource } from '../../authorization/index.js';
import { commandContext } from '../../workspaces/request/caller.js';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';

import type { WorkflowApplicationInput } from '../ports.js';
import {
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  WORKFLOW_AUTHORING_OPERATION,
  type WorkflowAuthoringTelemetry,
} from '../telemetry.js';
import type { workflowCreateRequestSchema } from '@pertexo/contracts';

import {
  serializeWorkflowCreate,
  type WorkflowCreateResult,
} from '../http/serializers.js';

import { type AuthoringPersistence, authorize } from './authorization.js';

export type CreateWorkflowInput = WorkflowApplicationInput &
  Readonly<{
    request: z.output<typeof workflowCreateRequestSchema>;
    idempotencyKey: string;
  }>;

export class CreateWorkflowService {
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
        const request = input.request;
        const created = await this.persistence.createWorkflow({
          ...commandContext(input),
          name: request.name,
          ...(request.folderId === undefined
            ? {}
            : { folderId: request.folderId }),
          emptyGraph: EMPTY_WORKFLOW_GRAPH,
          idempotencyKey: input.idempotencyKey,
        });
        return serializeWorkflowCreate(created);
      },
    );
  }
}
