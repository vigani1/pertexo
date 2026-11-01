import { PROMOTION_LIMITS } from '@pertexo/workflow-model';
import { utf8ByteLength } from '@pertexo/workflow-model';
import type {
  WorkflowPromotionPreview,
  WorkflowPromotionPreviewRequest,
} from '@pertexo/contracts';
import type { WorkspaceScopeRunner } from '@pertexo/database/primitives';
import { linkedPromotionTarget } from './authority.queries.js';
import { WorkflowPromotionError } from './errors.js';
import type { PromotionContext, PromotionScope } from './contract.js';
import { PromotionGraphBudget, promotionDigest } from './preparation/graph.js';
import { readPromotionSources } from './preparation/source.queries.js';
import { preparePromotionTarget } from './preparation/target.queries.js';

export async function preparePromotion(
  context: PromotionContext,
  inWorkspace: WorkspaceScopeRunner,
  input: PromotionScope & WorkflowPromotionPreviewRequest,
): Promise<WorkflowPromotionPreview> {
  const pair = await linkedPromotionTarget(inWorkspace, input);
  const budget = new PromotionGraphBudget();
  const sources = await inWorkspace(
    { workspaceId: input.workspaceId, actorId: input.actorId },
    (client) =>
      readPromotionSources(client, input.workspaceId, {
        actorId: input.actorId,
        selections: input.selections,
        budget,
      }),
  );
  const prepared = await inWorkspace(
    { workspaceId: pair.target.workspaceId, actorId: input.actorId },
    (client) =>
      preparePromotionTarget(client, context, {
        input: { ...input, workspaceId: pair.target.workspaceId },
        sourceWorkspaceId: input.workspaceId,
        sources,
        budget,
      }),
  );
  const policyIssue = promotionPolicyIssue({
    mode: input.mode,
    requireApproval: pair.target.requireApproval,
  });
  const requirements = [...prepared.requirements];
  if (policyIssue !== null)
    requirements.push({
      workflowId: input.selections[0]?.workflowId ?? input.workspaceId,
      kind: 'validation',
      status: 'incompatible',
      name: 'Publication policy',
      detail: policyIssue,
    });
  const data = {
    sourceWorkspaceId: input.workspaceId,
    sourceWorkspaceName: pair.source.name,
    targetWorkspaceId: pair.target.workspaceId,
    targetWorkspaceName: pair.target.name,
    mode: input.mode,
    requireApproval: pair.target.requireApproval,
    compatible: !requirements.some(
      (item) => item.status === 'missing' || item.status === 'incompatible',
    ),
    workflows: prepared.workflows,
    requirements,
  };
  const fingerprint = promotionDigest({
    actorId: input.actorId,
    link: pair.source,
    ...data,
    ...prepared.fingerprintFacts,
  });
  const result = { ...data, fingerprint };
  if (utf8ByteLength(JSON.stringify(result)) > PROMOTION_LIMITS.responseBytes)
    throw new WorkflowPromotionError(
      'limit',
      'This promotion review exceeds 4 MB. Select fewer workflows.',
    );
  return result;
}

function promotionPolicyIssue({
  mode,
  requireApproval,
}: Readonly<{
  mode: WorkflowPromotionPreviewRequest['mode'];
  requireApproval: boolean;
}>): string | null {
  if (mode === 'publish' && requireApproval) {
    return 'This target requires publication approval. Choose Request approval or Create drafts.';
  }
  if (mode === 'request_approval' && !requireApproval) {
    return 'Publication approval is off in the target. Choose Publish or Create drafts.';
  }
  return null;
}
