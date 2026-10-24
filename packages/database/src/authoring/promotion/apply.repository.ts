import { writePromotedDraft } from './writes/repository.js';
import type { WorkspaceScopeRunner } from '../../tenant-access/transactions.js';
import {
  promotionReceiptSchema,
  readAuthorizedPromotionReceipt,
} from './receipt.queries.js';
import type {
  WorkflowPromotionPreview,
  WorkflowPromotionResult,
} from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import {
  requirePromotionAuthority,
  lockPromotionWorkspaces,
} from './authority.queries.js';
import {
  WorkflowPromotionError,
  type PromotionContext,
  type WorkflowPromotionStore,
} from './contract.js';
import { preparePromotion } from './preview.js';

export async function applyPromotion(
  context: PromotionContext,
  input: Parameters<WorkflowPromotionStore['apply']>[0],
): Promise<WorkflowPromotionResult> {
  const command = {
    workspaceId: input.workspaceId,
    operation: 'workflow.promote',
    scope: input.actorId,
    idempotencyKey: input.idempotencyKey,
  };
  const request = {
    selections: input.selections,
    mode: input.mode,
    fingerprint: input.fingerprint,
    acknowledgeTargetChanges: input.acknowledgeTargetChanges,
    note: input.note ?? null,
  };
  // A completed command does not need its old source versions or a new review.
  const completed = await context.transact(
    input.workspaceId,
    input.actorId,
    async (client) => {
      await requirePromotionAuthority(client, input);
      return findCommandResult(client, { ...command, request });
    },
    input.signal,
  );
  if (completed !== null) {
    const stored = promotionReceiptSchema.parse(completed);
    return context.transactScopes(async (inWorkspace) => {
      await lockPromotionWorkspaces(
        inWorkspace,
        input,
        stored.targetWorkspaceId,
      );
      await inWorkspace(
        { workspaceId: input.workspaceId, actorId: input.actorId },
        (client) => requirePromotionAuthority(client, input),
      );
      await inWorkspace(
        { workspaceId: stored.targetWorkspaceId, actorId: input.actorId },
        (client) =>
          requirePromotionAuthority(
            client,
            { ...input, workspaceId: stored.targetWorkspaceId },
            input.mode === 'draft' ? 'workflow:update' : 'workflow:publish',
          ),
      );
      return readAuthorizedPromotionReceipt(
        inWorkspace,
        input,
        stored,
        input.selections.map((selection) => selection.workflowId),
      );
    }, input.signal);
  }
  return context.transactScopes(async (inWorkspace) => {
    // Prepare also acquires both workspace locks and rechecks current membership.
    const review = await preparePromotion(context, inWorkspace, input);
    const targetScope = {
      workspaceId: review.targetWorkspaceId,
      actorId: input.actorId,
    };
    await inWorkspace(targetScope, (client) =>
      requirePromotionAuthority(
        client,
        { ...input, workspaceId: review.targetWorkspaceId },
        input.mode === 'draft' ? 'workflow:update' : 'workflow:publish',
      ),
    );
    const promotionId = generatePersistedId();
    const replay = await inWorkspace(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      (client) =>
        claimCommand(client, { ...command, resourceId: promotionId, request }),
    );
    if (replay !== null) {
      const stored = promotionReceiptSchema.parse(replay);
      if (stored.targetWorkspaceId !== review.targetWorkspaceId)
        throw new WorkflowPromotionError(
          'stale',
          'The target changed while this command completed. Retry this exact command to retrieve its result.',
        );
      return readAuthorizedPromotionReceipt(
        inWorkspace,
        input,
        stored,
        input.selections.map((selection) => selection.workflowId),
      );
    }
    if (review.fingerprint !== input.fingerprint)
      throw new WorkflowPromotionError(
        'stale',
        'The source, target or its setup changed. Review this promotion again.',
      );
    if (!review.compatible)
      throw new WorkflowPromotionError(
        'incompatible',
        'Resolve the missing or incompatible requirements before promoting.',
      );
    const selectedIds = new Set(
      review.workflows.map((workflow) => workflow.sourceWorkflowId),
    );
    if (input.acknowledgeTargetChanges.some((id) => !selectedIds.has(id)))
      throw new WorkflowPromotionError(
        'conflict',
        'A target-change acknowledgement does not belong to this review.',
      );
    if (
      review.workflows.some(
        (workflow) =>
          workflow.directChanges &&
          !input.acknowledgeTargetChanges.includes(workflow.sourceWorkflowId),
      )
    )
      throw new WorkflowPromotionError(
        'conflict',
        'A target workflow was edited directly. Review and explicitly acknowledge replacing its changes.',
      );
    const items = await writeReviewedPromotion(inWorkspace, context, {
      input,
      review,
      promotionId,
      targetScope,
    });
    const result = {
      promotionId,
      sourceWorkspaceId: input.workspaceId,
      targetWorkspaceId: review.targetWorkspaceId,
      replayed: false,
      items,
    };
    await inWorkspace(
      { workspaceId: input.workspaceId, actorId: input.actorId },
      (client) =>
        completeCommand(client, command, {
          promotionId,
          targetWorkspaceId: review.targetWorkspaceId,
        }),
    );
    return result;
  }, input.signal);
}

async function writeReviewedPromotion(
  inWorkspace: WorkspaceScopeRunner,
  context: PromotionContext,
  {
    input,
    review,
    promotionId,
    targetScope,
  }: Readonly<{
    input: Parameters<WorkflowPromotionStore['apply']>[0];
    review: WorkflowPromotionPreview;
    promotionId: string;
    targetScope: Readonly<{ workspaceId: string; actorId: string }>;
  }>,
): Promise<WorkflowPromotionResult['items']> {
  const items = await inWorkspace(targetScope, async (client) => {
    const result: WorkflowPromotionResult['items'] = [];
    for (const workflow of review.workflows)
      result.push(
        await writePromotedDraft(client, context, {
          input,
          review,
          workflow,
          promotionId,
        }),
      );
    for (const item of result) {
      const source = review.workflows.find(
        (workflow) => workflow.sourceWorkflowId === item.sourceWorkflowId,
      );
      if (source === undefined)
        throw new Error('Promoted source was not reviewed');
      await appendAuditFact(client, {
        workspaceId: review.targetWorkspaceId,
        actorId: input.actorId,
        action: 'workflow.promoted',
        targetType: 'workflow',
        targetId: item.targetWorkflowId,
        requestId: input.requestId ?? null,
        traceId: input.traceId ?? null,
        metadata: {
          promotionId,
          sourceWorkspaceId: input.workspaceId,
          sourceWorkflowId: item.sourceWorkflowId,
          sourceVersionId: source.sourceVersionId,
          targetWorkspaceId: review.targetWorkspaceId,
          targetWorkflowId: item.targetWorkflowId,
          targetVersionId: item.publishedVersionId,
          publicationRequestId: item.publicationRequestId,
          workflowName: source.sourceName,
          mode: input.mode,
          revision: item.revision,
          acknowledgedTargetChanges: input.acknowledgeTargetChanges.includes(
            item.sourceWorkflowId,
          ),
        },
      });
    }
    return result;
  });
  await inWorkspace(
    { workspaceId: input.workspaceId, actorId: input.actorId },
    async (client) => {
      for (const item of items) {
        const source = review.workflows.find(
          (workflow) => workflow.sourceWorkflowId === item.sourceWorkflowId,
        );
        if (source === undefined)
          throw new Error('Promoted source was not reviewed');
        await appendAuditFact(client, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          action: 'workflow.promotion_sent',
          targetType: 'workflow',
          targetId: item.sourceWorkflowId,
          requestId: input.requestId ?? null,
          traceId: input.traceId ?? null,
          metadata: {
            promotionId,
            sourceWorkspaceId: input.workspaceId,
            sourceWorkflowId: item.sourceWorkflowId,
            sourceVersionId: source.sourceVersionId,
            targetWorkspaceId: review.targetWorkspaceId,
            targetWorkflowId: item.targetWorkflowId,
            targetVersionId: item.publishedVersionId,
            publicationRequestId: item.publicationRequestId,
            workflowName: source.sourceName,
            mode: input.mode,
            revision: item.revision,
            versionNumber: item.versionNumber,
          },
        });
      }
    },
  );

  return items;
}
