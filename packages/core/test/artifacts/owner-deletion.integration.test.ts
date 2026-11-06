import { expect, it } from 'vitest';
import { ARTIFACT_OWNER_SOURCES } from '@pertexo/database/schema';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { visibleArtifactIds } from '../../src/artifacts/references/access.repository.js';
import { ownerTransaction } from './lifetime.fixture.js';
import { workspaceId, userId } from '../lifecycle/retention.support.js';
import {
  artifactOwnerFixture,
  ownerLocations,
} from './owner-shapes.fixture.js';

it.each(ownerLocations)(
  'removes derived references and access when the %s owner is deleted',
  async (location) => {
    const state = await artifactOwnerFixture(location, 'descriptor');
    try {
      await ownerTransaction(async (client) => {
        const references = await client.query<{
          owner_family: string;
          owner_id: string;
          owner_sub_id: number;
        }>(
          'select owner_family,owner_id,owner_sub_id from app.artifact_owner_references where workspace_id=$1 and artifact_id=$2',
          [workspaceId, state.reference.artifactId],
        );
        expect(references.rows).toHaveLength(1);
        const reference = references.rows[0];
        const source = ARTIFACT_OWNER_SOURCES.find(
          (source) => source.table === reference?.owner_family,
        );
        if (!source || !reference) throw new Error('Reference owner missing');
        await client.query(
          `delete from app.${source.table} where workspace_id=$1 and ${source.id}=$2${source.sub ? ' and ' + source.sub + '=$3' : ''}`,
          source.sub
            ? [workspaceId, reference.owner_id, reference.owner_sub_id]
            : [workspaceId, reference.owner_id],
        );
        expect(
          (
            await client.query(
              'select artifact_id from app.artifact_owner_references where workspace_id=$1 and artifact_id=$2',
              [workspaceId, state.reference.artifactId],
            )
          ).rows,
        ).toEqual([]);
      });
      const visible = await withTenantScopedClient(
        state.pool,
        { workspaceId },
        (client) =>
          visibleArtifactIds(client, { workspaceId, actorId: userId }, [
            state.reference.artifactId,
          ]),
      );
      expect([...visible]).toEqual([]);
      await expect(state.coordinator.processNext()).resolves.toMatchObject({
        status: 'completed',
        artifactId: state.reference.artifactId,
      });
      expect(state.store.delete).toHaveBeenCalledOnce();
    } finally {
      await state.close();
    }
  },
);
