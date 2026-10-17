import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  governanceSettingsSchema,
  type GovernanceSettings,
} from '@pertexo/contracts';
import { claimCommand, completeCommand } from '../../platform/idempotency.js';
import { appendAuditFact } from '../audit/append.js';
import { GovernanceError, type GovernanceStore } from '../contract.js';
export async function readGovernanceSettings(
  client: PoolClient,
  workspaceId: string,
): Promise<GovernanceSettings> {
  const row = (
    await client.query<{
      governance_revision: number;
      audit_retention_days: number;
      require_publish_approval: boolean;
    }>(
      'select governance_revision,audit_retention_days,require_publish_approval from app.workspaces where id=$1',
      [workspaceId],
    )
  ).rows[0];
  if (row === undefined)
    throw new GovernanceError(
      'conflict',
      'Workspace settings are unavailable.',
    );
  return {
    revision: row.governance_revision,
    auditRetentionDays: row.audit_retention_days,
    requirePublishApproval: row.require_publish_approval,
  };
}
export async function configureGovernance(
  client: PoolClient,
  input: Parameters<GovernanceStore['configure']>[0],
): Promise<GovernanceSettings> {
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'workspace.governance.configure',
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand(client, {
    ...identity,
    resourceId: input.workspaceId,
    requestHash: createHash('sha256')
      .update(
        `${String(input.expectedRevision)}:${String(input.auditRetentionDays)}${input.requirePublishApproval === undefined ? '' : `:${String(input.requirePublishApproval)}`}`,
      )
      .digest('hex'),
  });
  if (replay !== null) return governanceSettingsSchema.parse(replay);
  const previous = await readGovernanceSettings(client, input.workspaceId);
  const saved = await client.query<{ governance_revision: number }>(
    'update app.workspaces set audit_retention_days=coalesce($3,audit_retention_days),require_publish_approval=coalesce($4,require_publish_approval),governance_revision=governance_revision+1,updated_at=clock_timestamp() where id=$1 and governance_revision=$2 returning governance_revision',
    [
      input.workspaceId,
      input.expectedRevision,
      input.auditRetentionDays ?? null,
      input.requirePublishApproval ?? null,
    ],
  );
  const row = saved.rows[0];
  if (row === undefined)
    throw new GovernanceError(
      'conflict',
      'Governance settings changed. Reload before saving.',
    );
  const result = {
    revision: row.governance_revision,
    auditRetentionDays: input.auditRetentionDays ?? previous.auditRetentionDays,
    requirePublishApproval:
      input.requirePublishApproval ?? previous.requirePublishApproval,
  };
  if (result.requirePublishApproval !== previous.requirePublishApproval)
    await client.query(
      "update app.workflow_publication_requests set status='stale' where workspace_id=$1 and status='pending'",
      [input.workspaceId],
    );
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
