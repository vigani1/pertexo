import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model';

import {
  commandCredential,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';

import {
  WORKFLOW_AUTHORING_OPERATION,
  NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  type WorkflowAuthoringTelemetry,
} from '../telemetry.js';
import type { WorkflowPublishResponse } from '../types.js';

import { serializeWorkflowPublication } from '../http/serializers.js';

import type { WorkflowResourceInput } from '../use-cases.js';
import {
  type AuthoringPersistence,
  authorize,
} from '../commands/authorization.js';

export type PublishWorkflowInput = WorkflowResourceInput &
  Readonly<{
    representationTag: string;
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;

export class PublishWorkflowUseCase {
  public constructor(
    private readonly persistence: AuthoringPersistence<'publishWorkflow'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly telemetry: WorkflowAuthoringTelemetry = NOOP_WORKFLOW_AUTHORING_TELEMETRY,
  ) {}

  public execute(
    input: PublishWorkflowInput,
  ): Promise<WorkflowPublishResponse> {
    return this.telemetry.measure(
      WORKFLOW_AUTHORING_OPERATION.publish,
      async () => {
        await authorize(input, 'workflow:publish', this.authorization);
        // The opaque If-Match is handed to persistence without a preliminary
        // draft read. Persistence must resolve an exact idempotent replay
        // before looking up the current draft or evaluating the tag.
        const result = await this.persistence.publishWorkflow({
          workspaceId: input.routeWorkspaceId,
          workflowId: input.workflowId,
          actorId: input.actor.actorId,
          representationTag: input.representationTag,
          requestHash: publishRequestHash(input),
          idempotencyKey: input.idempotencyKey,
          ...commandCredential(input.actor),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.requestId === undefined
            ? {}
            : { requestId: input.requestId }),
          ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
        });
        return serializeWorkflowPublication(result.version, {
          reused: result.reused,
        });
      },
    );
  }
}

function publishRequestHash(input: PublishWorkflowInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'pertexo.workflow.publish-request',
        actorId: input.actor.actorId,
        workspaceId: input.routeWorkspaceId,
        workflowId: input.workflowId,
        representationTag: input.representationTag,
      }),
    )
    .digest('hex');
}
