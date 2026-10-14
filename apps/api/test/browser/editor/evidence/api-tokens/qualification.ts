import { createHash } from 'node:crypto';
import { z } from 'zod';
import { expect } from 'vitest';
import type { Pool } from 'pg';
import { workflowGraphSchema } from '@pertexo/contracts';

export const apiTokensEvidenceSchema = z.strictObject({
  cli: z.strictObject({
    tokenId: z.uuid(),
    sourceWorkflowId: z.uuid(),
    importedWorkflowId: z.uuid(),
    versionId: z.uuid(),
    runId: z.uuid(),
  }),
  owners: z
    .array(
      z.strictObject({
        workspaceId: z.uuid(),
        ownerUserId: z.uuid(),
        tokenId: z.uuid(),
      }),
    )
    .length(2),
});

export async function verifyApiTokensEvidence(
  database: Pool,
  evidence: z.infer<typeof apiTokensEvidenceSchema>,
) {
  await verifyAutomationCliEvidence(database, evidence);
  for (const owner of evidence.owners) {
    const rows = await database.query<{
      id: string;
      owner_user_id: string;
      revoked: boolean;
      used: boolean;
      digest_valid: boolean;
      scopes: string[];
      membership_revision: number;
      role_revision: number;
    }>(
      `select token.id,token.owner_user_id,token.revoked_at is not null revoked,
      token.last_used_at is not null used,token.secret_digest ~ '^[0-9a-f]{64}$' digest_valid,
      token.scopes,token.membership_revision,member.role_revision
      from app.api_tokens token join app.workspace_memberships member
      on member.workspace_id=token.workspace_id and member.user_id=token.owner_user_id
      where token.workspace_id=$1 and token.id=$2`,
      [owner.workspaceId, owner.tokenId],
    );
    expect(rows.rows).toEqual([
      {
        id: owner.tokenId,
        owner_user_id: owner.ownerUserId,
        revoked: true,
        used: true,
        digest_valid: true,
        scopes: ['run:read', 'workflow:read'],
        membership_revision: 1,
        role_revision: 1,
      },
    ]);
    const audit = await database.query<{
      action: string;
      actor_user_id: string;
      metadata: unknown;
    }>(
      'select action,actor_user_id,metadata from app.audit_events where workspace_id=$1 and target_id=$2 order by action',
      [owner.workspaceId, owner.tokenId],
    );
    expect(audit.rows).toEqual([
      {
        action: 'api.token.created',
        actor_user_id: owner.ownerUserId,
        metadata: {},
      },
      {
        action: 'api.token.revoked',
        actor_user_id: owner.ownerUserId,
        metadata: {},
      },
    ]);
    const receipts = await database.query<{ result_ref: unknown }>(
      'select result_ref from app.idempotency_records where workspace_id=$1 and resource_id=$2',
      [owner.workspaceId, owner.tokenId],
    );
    expect(receipts.rows).toHaveLength(2);
    for (const receipt of receipts.rows)
      expect(receipt.result_ref).toEqual({ tokenId: owner.tokenId });
  }
}

async function verifyAutomationCliEvidence(
  database: Pool,
  evidence: z.infer<typeof apiTokensEvidenceSchema>,
) {
  const workspaceId = evidence.owners[0]?.workspaceId;
  if (workspaceId === undefined) throw new Error('CLI owner missing');
  const proof = evidence.cli;
  const token = (
    await database.query<{ scopes: string[]; revoked: boolean; used: boolean }>(
      'select scopes,revoked_at is not null revoked,last_used_at is not null used from app.api_tokens where workspace_id=$1 and id=$2',
      [workspaceId, proof.tokenId],
    )
  ).rows;
  expect(token).toEqual([
    {
      scopes: [
        'run:cancel',
        'run:read',
        'run:start',
        'workflow:create',
        'workflow:publish',
        'workflow:read',
      ],
      revoked: true,
      used: true,
    },
  ]);
  const drafts = (
    await database.query<{ workflow_id: string; graph_json: unknown }>(
      'select workflow_id,graph_json from app.workflow_drafts where workspace_id=$1 and workflow_id=any($2::uuid[])',
      [workspaceId, [proof.sourceWorkflowId, proof.importedWorkflowId]],
    )
  ).rows;
  expect(drafts).toHaveLength(2);
  const source = workflowGraphSchema.parse(
    drafts.find((row) => row.workflow_id === proof.sourceWorkflowId)
      ?.graph_json,
  );
  const imported = workflowGraphSchema.parse(
    drafts.find((row) => row.workflow_id === proof.importedWorkflowId)
      ?.graph_json,
  );
  expect(imported).toEqual(source);
  const versions = (
    await database.query<{
      id: string;
      workflow_id: string;
      graph_json: unknown;
    }>(
      'select id,workflow_id,graph_json from app.workflow_versions where workspace_id=$1 and workflow_id=any($2::uuid[])',
      [workspaceId, [proof.sourceWorkflowId, proof.importedWorkflowId]],
    )
  ).rows;
  expect(versions).toHaveLength(1);
  expect(versions[0]).toMatchObject({
    id: proof.versionId,
    workflow_id: proof.importedWorkflowId,
  });
  expect(workflowGraphSchema.parse(versions[0]?.graph_json)).toEqual(source);
  const runs = (
    await database.query<{
      id: string;
      workflow_id: string;
      workflow_version_id: string;
      status: string;
    }>(
      'select id,workflow_id,workflow_version_id,status from app.workflow_runs where workspace_id=$1',
      [workspaceId],
    )
  ).rows;
  expect(runs).toEqual([
    {
      id: proof.runId,
      workflow_id: proof.importedWorkflowId,
      workflow_version_id: proof.versionId,
      status: 'succeeded',
    },
  ]);
  const nodes = (
    await database.query<{ status: string; output_ref: unknown }>(
      'select status,output_ref from app.node_runs where workspace_id=$1 and workflow_run_id=$2',
      [workspaceId, proof.runId],
    )
  ).rows;
  expect(nodes).toEqual([
    {
      status: 'succeeded',
      output_ref: {
        kind: 'inline',
        value: { value: 'completed CLI qualification' },
      },
    },
  ]);
  const receipts = (
    await database.query<{
      operation: string;
      scope: string;
      key_hash: string;
    }>(
      "select operation,scope,key_hash from app.idempotency_records where workspace_id=$1 and operation in ('workflow.import','workflow.publish','workflow.run.accept') order by operation",
      [workspaceId],
    )
  ).rows;
  expect(receipts).toHaveLength(3);
  expect(receipts.map((row) => row.operation)).toEqual([
    'workflow.import',
    'workflow.publish',
    'workflow.run.accept',
  ]);
  const keys: Readonly<Record<string, string>> = {
    'workflow.import': 'live-cli-import',
    'workflow.run.accept': 'live-cli-start',
    'workflow.publish': 'live-cli-publish',
  };
  for (const receipt of receipts) {
    expect(receipt.scope).toMatch(/^api_token:[0-9a-f]{64}$/u);
    expect(receipt.key_hash).toBe(
      createHash('sha256')
        .update(keys[receipt.operation] ?? '')
        .digest('hex'),
    );
  }
}
