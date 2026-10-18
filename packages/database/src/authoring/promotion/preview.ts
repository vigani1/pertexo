import {
  PROMOTION_LIMITS,
  type WorkflowPromotionPreview,
  type WorkflowPromotionPreviewRequest,
} from '@pertexo/contracts';
import type { WorkspaceScopeRunner } from '../../tenant-access/transactions.js';
import { linkedPromotionTarget } from './authority.js';
import {
  WorkflowPromotionError,
  type PromotionContext,
  type PromotionScope,
} from './contract.js';
import { PromotionGraphBudget, promotionDigest } from './preparation/graph.js';
import { readPromotionSources } from './preparation/source.js';
import { preparePromotionTarget } from './preparation/target.js';

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
      readPromotionSources(client, input.workspaceId, input.selections, budget),
  );
  const prepared = await inWorkspace(
    { workspaceId: pair.target.workspaceId, actorId: input.actorId },
    (client) =>
      preparePromotionTarget(
        client,
        context,
        { ...input, workspaceId: pair.target.workspaceId },
        input.workspaceId,
        sources,
        budget,
      ),
  );
  const policyIssue =
    input.mode === 'publish' && pair.target.requireApproval
      ? 'This target requires publication approval. Choose Request approval or Create drafts.'
      : input.mode === 'request_approval' && !pair.target.requireApproval
        ? 'Publication approval is off in the target. Choose Publish or Create drafts.'
        : null;
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
  if (
    Buffer.byteLength(JSON.stringify(result)) > PROMOTION_LIMITS.responseBytes
  )
    throw new WorkflowPromotionError(
      'limit',
      'This promotion review exceeds 4 MB. Select fewer workflows.',
    );
  return result;
}
