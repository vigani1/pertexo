import type { WorkspaceScopeRunner } from '../../tenant-access/transactions.js';
import {
  promotionReceiptSchema,
  readAuthorizedPromotionReceipt,
} from './receipt.queries.js';
import type {
  WorkflowPromotionPreview,
  WorkflowPromotionResult,
} from '@pertexo/contracts';
import type { PoolClient } from 'pg';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import {
  claimCommand,
  completeCommand,
  findCommandResult,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { appendAuditFact } from '../../governance/audit/events.repository.js';
import { pruneStepSamples } from '../step-samples/records.repository.js';
import { publishWorkflowDirectly } from '../publication/publisher.repository.js';
import { requestPublicationReview } from '../reviews/request.repository.js';
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
import { promotionDigest } from './preparation/graph.js';

async function writePromotedDraft(
  client: PoolClient,
  context: PromotionContext,
  {
    input,
    review,
    workflow,
    promotionId,
  }: Readonly<{
    input: Parameters<WorkflowPromotionStore['apply']>[0];
    review: WorkflowPromotionPreview;
    workflow: WorkflowPromotionPreview['workflows'][number];
    promotionId: string;
  }>,
) {
  const workspaceId = review.targetWorkspaceId;
  const workflowId = workflow.targetWorkflowId ?? generatePersistedId();
  const revision = (workflow.targetRevision ?? 0) + 1;
  if (workflow.targetWorkflowId === null) {
    await client.query(
      `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,$3,$4)`,
      [workflowId, workspaceId, workflow.sourceName, input.actorId],
    );
    await client.query(
      'insert into app.workflow_drafts(workflow_id,workspace_id,revision,graph_json,updated_by) values($1,$2,1,$3::json,$4)',
      [
        workflowId,
        workspaceId,
        JSON.stringify(workflow.proposedGraph),
        input.actorId,
      ],
    );
  } else {
    await client.query(
      'update app.workflow_drafts set graph_json=$3::json,revision=$4,updated_by=$5,updated_at=clock_timestamp() where workspace_id=$1 and workflow_id=$2',
      [
        workspaceId,
        workflowId,
        JSON.stringify(workflow.proposedGraph),
        revision,
        input.actorId,
      ],
    );
    await client.query(
      'update app.workflows set name=$3::varchar,name_revision=name_revision+case when name<>$3::varchar then 1 else 0 end,updated_at=clock_timestamp() where workspace_id=$1 and id=$2',
      [workspaceId, workflowId, workflow.sourceName],
    );
    await pruneStepSamples(
      client,
      workspaceId,
      workflowId,
      workflow.proposedGraph,
    );
  }
  await client.query(
    `insert into app.workflow_promotion_origins(workspace_id,workflow_id,source_workspace_id,source_workflow_id,source_version_id,source_checksum,graph_digest,target_name,draft_revision,published_version_id,promotion_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(workspace_id,workflow_id) do update set source_version_id=excluded.source_version_id,source_checksum=excluded.source_checksum,graph_digest=excluded.graph_digest,target_name=excluded.target_name,draft_revision=excluded.draft_revision,published_version_id=excluded.published_version_id,promotion_id=excluded.promotion_id,applied_at=clock_timestamp()`,
    [
      workspaceId,
      workflowId,
      input.workspaceId,
      workflow.sourceWorkflowId,
      workflow.sourceVersionId,
      workflow.sourceChecksum,
      promotionDigest(workflow.proposedGraph),
      workflow.sourceName,
      revision,
      workflow.targetPublishedVersionId,
      promotionId,
    ],
  );
  const representationTag = workflowDraftRepresentationTag({
    workflowId,
    revision,
    graph: workflow.proposedGraph,
    compatibilityFingerprint: workflowCompatibilityReport(
      workflow.proposedGraph,
      context.catalogs.definitionCatalog,
    ).fingerprint,
  });
  const command = { ...input, workspaceId, workflowId, representationTag };
  let publishedVersionId: string | null = null;
  let versionNumber: number | null = null;
  let publicationRequestId: string | null = null;
  if (input.mode === 'publish') {
    const published = await publishWorkflowDirectly(context, client, command);
    publishedVersionId = published.version.id;
    versionNumber = published.version.versionNumber;
  } else if (input.mode === 'request_approval') {
    const requested = await requestPublicationReview(client, context, {
      ...command,
      idempotencyKey: `${promotionId}:${workflowId}`,
      note: input.note ?? 'Review this promoted workflow.',
    });
    publicationRequestId = requested.id;
  }
  return {
    sourceWorkflowId: workflow.sourceWorkflowId,
    targetWorkflowId: workflowId,
    revision,
    publishedVersionId,
    versionNumber,
    publicationRequestId,
  };
}

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
