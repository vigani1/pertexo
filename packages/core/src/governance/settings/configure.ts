import {
  hasAnotherManager,
  invalidatePendingReviews,
  readGovernanceSettings,
  updateGovernanceSettings,
} from './policy.repository.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../audit/facts.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { GovernanceSettings } from '@pertexo/contracts';
import { requiresPublicationReviewer } from '@pertexo/workflow-model';
import type { ConfigureGovernanceInput } from '../governance.types.js';
import { GovernanceError } from '../governance.errors.js';
export async function configureGovernance(
  client: PoolClient,
  input: ConfigureGovernanceInput,
): Promise<GovernanceSettings> {
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'workspace.governance.configure',
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand<GovernanceSettings>(client, {
    ...identity,
    resourceId: input.workspaceId,
    requestHash: createHash('sha256')
      .update(
        `${String(input.expectedRevision)}:${String(input.auditRetentionDays)}${input.requirePublishApproval === undefined ? '' : `:${String(input.requirePublishApproval)}`}`,
      )
      .digest('hex'),
  });
  if (replay !== null) return replay;
  const previous = await readGovernanceSettings(client, input.workspaceId);
  if (
    requiresPublicationReviewer(previous, input) &&
    !(await hasAnotherManager(client, input))
  )
    throw new GovernanceError(
      'invalid',
      'Add another active owner or admin before requiring approval to publish.',
    );
  const row = await updateGovernanceSettings(client, input);
  if (row === undefined)
    throw new GovernanceError(
      'conflict',
      'Governance settings changed. Reload before saving.',
    );
  const result = {
    revision: row.revision,
    auditRetentionDays: input.auditRetentionDays ?? previous.auditRetentionDays,
    requirePublishApproval:
      input.requirePublishApproval ?? previous.requirePublishApproval,
  };
  if (result.requirePublishApproval !== previous.requirePublishApproval)
    await invalidatePendingReviews(client, input.workspaceId);
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workspace.governance_changed',
    targetType: 'workspace',
    targetId: input.workspaceId,
    metadata: result,
  });
  await completeCommand(client, identity, result);
  return result;
}
