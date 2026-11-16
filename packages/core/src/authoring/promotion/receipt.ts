import type { WorkspaceScopeRunner } from '@pertexo/database/primitives';

import { readFolderScope } from '../../shared/folder-access-facts.repository.js';

import type { PromotionScope } from './workflow-promotion.types.js';

import type { PoolClient } from 'pg';

import type { z } from 'zod';

import { WorkflowPromotionError } from './workflow-promotion.errors.js';

import type { promotionReceiptSchema } from './receipt.repository.js';
import {
  readPromotionAudit,
  countUpdatableWorkflows,
} from './receipt.repository.js';

async function readPromotionReceipt(
  client: PoolClient,
  workspaceId: string,
  {
    actorId,
    receipt,
    workflowIds,
  }: Readonly<{
    actorId: string;
    receipt: z.output<typeof promotionReceiptSchema>;
    workflowIds: readonly string[];
  }>,
) {
  const scope = await readFolderScope(client, { workspaceId, actorId });
  const rows = await readPromotionAudit(client, workspaceId, {
    scope,
    promotionId: receipt.promotionId,
    workflowIds,
  });
  if (rows.length !== workflowIds.length)
    throw new WorkflowPromotionError(
      'unavailable',
      'This promotion receipt is no longer available. Inspect the target before starting another promotion.',
    );
  return {
    promotionId: receipt.promotionId,
    sourceWorkspaceId: workspaceId,
    targetWorkspaceId: receipt.targetWorkspaceId,
    replayed: true,
    items: rows.map(({ metadata }) => ({
      sourceWorkflowId: metadata.sourceWorkflowId,
      targetWorkflowId: metadata.targetWorkflowId,
      revision: metadata.revision,
      publishedVersionId: metadata.targetVersionId,
      versionNumber: metadata.versionNumber,
      publicationRequestId: metadata.publicationRequestId,
    })),
  };
}

export async function readAuthorizedPromotionReceipt(
  inWorkspace: WorkspaceScopeRunner,
  input: PromotionScope,
  receipt: z.output<typeof promotionReceiptSchema>,
  workflowIds: readonly string[],
) {
  const result = await inWorkspace(input, (client) =>
    readPromotionReceipt(client, input.workspaceId, {
      actorId: input.actorId,
      receipt,
      workflowIds,
    }),
  );
  await inWorkspace(
    { workspaceId: receipt.targetWorkspaceId, actorId: input.actorId },
    async (client) => {
      const scope = await readFolderScope(client, {
        workspaceId: receipt.targetWorkspaceId,
        actorId: input.actorId,
      });
      const found = await countUpdatableWorkflows(
        client,
        receipt.targetWorkspaceId,
        scope,
        result.items.map((item) => item.targetWorkflowId),
      );
      if (found !== result.items.length)
        throw new WorkflowPromotionError(
          'unavailable',
          'The target workflow is unavailable.',
        );
    },
  );
  return result;
}
