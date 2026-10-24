import { expect, it } from 'vitest';

import {
  lockArtifactReferences,
  requireNodeArtifactReference,
} from '../../../src/artifacts/references/repository.js';
import { ArtifactMetadataNotFoundError } from '../../../src/artifacts/input.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../../src/tenant-access/transactions.js';
import {
  workspaceId,
  userId,
  randomUUID,
} from '../../lifecycle/retention.support.js';
import { ownerTransaction, fixture } from './fixture.js';

export function registerKeepsPreviewOutputReadableLive(
  shape: Parameters<typeof fixture>[0],
): void {
  it('keeps preview output readable only in a live preview context and refuses durable promotion', async () => {
    const state = await fixture(shape);
    const previewRunId = randomUUID();
    try {
      await ownerTransaction(async (client) => {
        await client.query(
          `insert into app.preview_runs(id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,definition_key,definition_version,executor_key,executor_version,actor_user_id,idempotency_key_hash,request_hash,executable_node_json,input_ref,side_effect_class,may_contact_provider,may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at)
          values($1,$2,$3,1,$4,'file','core.set',1,'core.set',1,$5,$6,$7,'{}'::jsonb,'{"kind":"inline","value":null}'::jsonb,'safe',false,false,'not_supported',clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 day')`,
          [
            previewRunId,
            workspaceId,
            state.workflowId,
            'a'.repeat(64),
            userId,
            'b'.repeat(64),
            'c'.repeat(64),
          ],
        );
        await client.query(
          "insert into app.artifact_links(workspace_id,artifact_id,owner_kind,owner_id) values($1,$2,'preview_run',$3)",
          [workspaceId, state.reference.artifactId, previewRunId],
        );
      });
      await expect(
        withTenantScopedClient(state.pool, { workspaceId }, (client) =>
          lockArtifactReferences(client, workspaceId, state.graph, userId),
        ),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      await expect(
        withWorkspaceTransaction(state.pool, workspaceId, (transaction) =>
          requireNodeArtifactReference(transaction, state.reference),
        ),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      await expect(
        withWorkspaceTransaction(state.pool, workspaceId, (transaction) =>
          requireNodeArtifactReference(
            transaction,
            state.reference,
            previewRunId,
          ),
        ),
      ).resolves.toBeUndefined();
      await ownerTransaction((client) =>
        client.query(
          "update app.preview_runs set created_at=clock_timestamp()-interval '2 days',execution_deadline_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2",
          [workspaceId, previewRunId],
        ),
      );
      await expect(
        withWorkspaceTransaction(state.pool, workspaceId, (transaction) =>
          requireNodeArtifactReference(
            transaction,
            state.reference,
            previewRunId,
          ),
        ),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      await ownerTransaction(async (client) => {
        await client.query(
          'delete from app.artifact_links where workspace_id=$1 and artifact_id=$2',
          [workspaceId, state.reference.artifactId],
        );
        await client.query(
          'delete from app.preview_runs where workspace_id=$1 and id=$2',
          [workspaceId, previewRunId],
        );
      });
      await state.coordinator.processNext();
    } finally {
      await state.close();
    }
  });

  it('refuses an existing artifact in a different active workspace', async () => {
    const state = await fixture(shape);
    const foreignWorkspaceId = randomUUID();
    try {
      await ownerTransaction(async (client) => {
        await client.query("select set_config('app.workspace_id',$1,true)", [
          foreignWorkspaceId,
        ]);
        await client.query(
          "insert into app.workspaces(id,name,slug,created_by) values($1,'Foreign file workspace',$2,$3)",
          [foreignWorkspaceId, 'file-' + foreignWorkspaceId, userId],
        );
      });
      await expect(
        withTenantScopedClient(
          state.pool,
          { workspaceId: foreignWorkspaceId },
          (client) =>
            lockArtifactReferences(
              client,
              foreignWorkspaceId,
              state.graph,
              userId,
            ),
        ),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      await state.coordinator.processNext();
    } finally {
      await state.close();
    }
  });
}
