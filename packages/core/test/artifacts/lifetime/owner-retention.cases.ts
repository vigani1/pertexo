import { expect, it } from 'vitest';

import { lockArtifactReferences } from '../../../src/artifacts/references/repository.js';
import { ArtifactMetadataNotFoundError } from '../../../src/artifacts/input.js';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import {
  workspaceId,
  userId,
  randomUUID,
} from '../../lifecycle/retention.support.js';
import { gate, ownerTransaction, fixture, addVersion } from './fixture.js';

export function registerArtifactOwnerRetention(
  shape: Parameters<typeof fixture>[0],
): void {
  it('conservatively retains nested artifactId values without an artifact-kind marker', async () => {
    const state = await fixture(shape);
    try {
      const graph = {
        ...state.graph,
        nodes: state.graph.nodes.map((node) => ({
          ...node,
          inputMappings: {
            payload: {
              kind: 'literal',
              value: { nested: [{ artifactId: state.reference.artifactId }] },
            },
          },
        })),
      };
      await ownerTransaction((client) =>
        client.query(
          'update app.workflow_drafts set graph_json=$3::jsonb where workspace_id=$1 and workflow_id=$2',
          [workspaceId, state.workflowId, JSON.stringify(graph)],
        ),
      );
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'referenced',
        artifactId: state.reference.artifactId,
      });
      expect(state.store.delete).not.toHaveBeenCalled();
      await state.clear();
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'completed',
        artifactId: state.reference.artifactId,
      });
    } finally {
      await state.close();
    }
  });

  it.each(['draft', 'version', 'input-case'] as const)(
    'keeps a file while its %s owner exists, then erases it after reference release',
    async (kind) => {
      const state = await fixture(shape);
      try {
        if (kind === 'draft')
          await ownerTransaction((client) =>
            client.query(
              'update app.workflow_drafts set graph_json=$3::jsonb where workspace_id=$1 and workflow_id=$2',
              [workspaceId, state.workflowId, JSON.stringify(state.graph)],
            ),
          );
        else if (kind === 'version') await addVersion(state, state.graph);
        else {
          await addVersion(state);
          const caseId = randomUUID();
          const input = JSON.stringify({ file: state.reference });
          await ownerTransaction(async (client) => {
            await client.query(
              "insert into app.workflow_input_cases(id,workspace_id,workflow_id,workflow_version_id,version_checksum,name,revision) values($1,$2,$3,$4,$5,'File case',2)",
              [
                caseId,
                workspaceId,
                state.workflowId,
                state.versionId,
                'wf:sha256:' + 'a'.repeat(64),
              ],
            );
            for (const revision of [1, 2])
              await client.query(
                'insert into app.workflow_input_case_payloads(workspace_id,case_id,revision,input,canonical_bytes) values($1,$2,$3,$4,$5)',
                [
                  workspaceId,
                  caseId,
                  revision,
                  input,
                  Buffer.byteLength(input),
                ],
              );
          });
        }
        await expect(state.coordinator.processNext()).resolves.toMatchObject({
          status: 'referenced',
          artifactId: state.reference.artifactId,
        });
        expect(state.store.delete).not.toHaveBeenCalled();
        await state.clear();
        await expect(state.coordinator.processNext()).resolves.toMatchObject({
          status: 'completed',
          artifactId: state.reference.artifactId,
        });
        expect(state.store.delete).toHaveBeenCalledOnce();
        const remaining = await ownerTransaction((client) =>
          client.query(
            'select id from app.artifacts where workspace_id=$1 and id=$2',
            [workspaceId, state.reference.artifactId],
          ),
        );
        expect(remaining.rows).toEqual([]);
      } finally {
        await state.close();
      }
    },
  );

  it('lets an accepted writer win without exposing its file to concurrent deletion', async () => {
    const state = await fixture(shape);
    const held = gate();
    const release = gate();
    const writer = withTenantScopedClient(
      state.pool,
      { workspaceId },
      async (client) => {
        await lockArtifactReferences(client, workspaceId, state.graph, userId);
        held.open();
        await release.promise;
        await client.query(
          'update app.workflow_drafts set graph_json=$3::jsonb where workspace_id=$1 and workflow_id=$2',
          [workspaceId, state.workflowId, JSON.stringify(state.graph)],
        );
      },
    );
    try {
      await held.promise;
      await expect(state.coordinator.processNext()).resolves.toEqual({
        status: 'idle',
      });
      release.open();
      await writer;
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'referenced',
        artifactId: state.reference.artifactId,
      });
      expect(state.store.delete).not.toHaveBeenCalled();
      await state.clear();
      await state.coordinator.processNext();
    } finally {
      release.open();
      await writer;
      await state.close();
    }
  });

  it('refuses a new owner after cleanup wins, including while physical deletion is pending', async () => {
    const state = await fixture(shape);
    const deleting = gate();
    const release = gate();
    state.store.delete.mockImplementation(async () => {
      deleting.open();
      await release.promise;
    });
    const cleanup = state.coordinator.processNext();
    try {
      await deleting.promise;
      await expect(
        withTenantScopedClient(state.pool, { workspaceId }, async (client) => {
          await lockArtifactReferences(
            client,
            workspaceId,
            state.graph,
            userId,
          );
          await client.query(
            'update app.workflow_drafts set graph_json=$3::jsonb where workspace_id=$1 and workflow_id=$2',
            [workspaceId, state.workflowId, JSON.stringify(state.graph)],
          );
        }),
      ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      release.open();
      await expect(cleanup).resolves.toMatchObject({
        status: 'completed',
        artifactId: state.reference.artifactId,
      });
    } finally {
      release.open();
      await cleanup;
      await state.close();
    }
  });

  it('rejects unavailable identity and tampered metadata', async () => {
    const state = await fixture(shape);
    try {
      for (const reference of [
        { ...state.reference, artifactId: randomUUID() },
        { ...state.reference, byteLength: 3 },
        { ...state.reference, sha256: 'b'.repeat(64) },
      ])
        await expect(
          withTenantScopedClient(state.pool, { workspaceId }, (client) =>
            lockArtifactReferences(client, workspaceId, reference, userId),
          ),
        ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
      await state.coordinator.processNext();
    } finally {
      await state.close();
    }
  });
}
