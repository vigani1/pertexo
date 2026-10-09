import {
  workflowOrganizationBulkRequestSchema,
  workflowOrganizationBulkResponseSchema,
  workflowOrganizationBulkItemOutcomeSchema,
  workflowFolderPlacementResponseSchema,
  workflowTagCleanupDetachRequestSchema,
  workflowTagCleanupDetachResponseSchema,
  type WorkflowOrganizationBulkItemOutcome,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  WorkflowFolderConflictError,
  WorkflowNotFoundError,
  WorkflowOrganizationUnavailableError,
  WorkflowTagConflictError,
  type WorkflowOrganizationBatchDatabase,
  type WorkflowOrganizationBatchRequest,
} from '@pertexo/database/authoring';
import {
  AuthorizationError,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import {
  authorizeWorkflowOrganization,
  workflowOrganizationContext,
  type WorkflowOrganizationInput,
} from './organization-authority.js';

type Input = WorkflowOrganizationInput &
  Readonly<{ request: unknown; idempotencyKey: string }>;

/** Commit one shared parent before sequential, independently committed items.
 * Retrying always resubmits the full original parent, never just failed items. */
export class WorkflowOrganizationBatchesUseCase {
  public constructor(
    private readonly batches: WorkflowOrganizationBatchDatabase,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async bulk(input: Input) {
    const request = workflowOrganizationBulkRequestSchema.parse(input.request);
    return workflowOrganizationBulkResponseSchema.parse({
      items: await this.execute(input, request),
    });
  }

  public async cleanup(input: Input) {
    const request = workflowTagCleanupDetachRequestSchema.parse(input.request);
    const items = await this.execute(input, {
      operation: 'tag_cleanup',
      tagId: request.tagId,
      items: request.items,
    });
    return workflowTagCleanupDetachResponseSchema.parse({
      items: items.map((item) =>
        item.status === 'updated'
          ? { ...item, status: 'detached' as const }
          : item,
      ),
    });
  }

  private async execute(
    input: Input,
    request: WorkflowOrganizationBatchRequest,
  ) {
    const role = request.operation === 'tag_cleanup' ? 'admin' : 'editor';
    await authorizeWorkflowOrganization(input, this.authorization, role, true);
    const command = {
      ...workflowOrganizationContext(input),
      idempotencyKey: input.idempotencyKey,
      request,
    };
    // A failure here is a whole-request failure with no item attempted.
    await this.batches.admitBatch(command);
    input.signal?.throwIfAborted();
    const outcomes: WorkflowOrganizationBulkItemOutcome[] = [];
    let authorityLost = false;
    for (const { workflowId } of request.items) {
      input.signal?.throwIfAborted();
      if (authorityLost) {
        outcomes.push({ workflowId, status: 'not_processed' });
        continue;
      }
      let outcome: WorkflowOrganizationBulkItemOutcome;
      try {
        await authorizeWorkflowOrganization(
          input,
          this.authorization,
          role,
          true,
        );
        const result = await this.batches.executeBatchItem({
          ...command,
          workflowId,
        });
        input.signal?.throwIfAborted();
        if (result.workflowId !== workflowId)
          throw new Error('Organization item identity is incompatible');
        if (request.operation === 'move')
          workflowFolderPlacementResponseSchema.parse(result);
        else
          workflowOrganizationBulkItemOutcomeSchema.parse({
            ...result,
            status: 'updated',
          });
        outcome = workflowOrganizationBulkItemOutcomeSchema.parse({
          workflowId,
          status: 'updated',
          organizationRevision: result.organizationRevision,
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        input.signal?.throwIfAborted();
        outcome = await this.failure(input, request, workflowId, role, error);
      }
      authorityLost = outcome.status === 'forbidden';
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async failure(
    input: Input,
    request: WorkflowOrganizationBatchRequest,
    workflowId: string,
    role: 'admin' | 'editor',
    error: unknown,
  ): Promise<WorkflowOrganizationBulkItemOutcome> {
    if (error instanceof AuthorizationError)
      return { workflowId, status: 'forbidden' };
    if (error instanceof WorkflowNotFoundError) {
      // SQL deliberately shares its non-disclosure error for vanished authority
      // and invisible resources. A fresh application lookup distinguishes loss
      // of authority without revealing whether the selected workflow exists.
      try {
        await authorizeWorkflowOrganization(
          input,
          this.authorization,
          role,
          true,
        );
        return { workflowId, status: 'not_visible' };
      } catch (authorityError: unknown) {
        input.signal?.throwIfAborted();
        return {
          workflowId,
          status:
            authorityError instanceof AuthorizationError
              ? 'forbidden'
              : 'outcome_unknown',
        };
      }
    }
    if (error instanceof WorkflowOrganizationUnavailableError)
      return {
        workflowId,
        status: 'unavailable',
        code: 'workflow.organization_unavailable',
      };
    if (error instanceof IdempotencyConflictError)
      return {
        workflowId,
        status: 'conflict',
        code: 'request.idempotency_conflict',
      };
    if (error instanceof WorkflowTagConflictError) {
      if (error.kind === 'organization_revision')
        return {
          workflowId,
          status: 'conflict',
          code: 'workflow.organization_revision_conflict',
        };
      if (error.kind === 'lifecycle')
        return {
          workflowId,
          status: 'conflict',
          code: 'workflow.lifecycle_conflict',
        };
    }
    if (
      request.operation === 'move' &&
      error instanceof WorkflowFolderConflictError &&
      error.kind === 'not_visible'
    )
      return {
        workflowId,
        status: 'conflict',
        code: 'workflow.folder_not_visible',
      };
    return { workflowId, status: 'outcome_unknown' };
  }
}
