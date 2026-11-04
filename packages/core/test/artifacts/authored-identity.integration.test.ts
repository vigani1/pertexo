import { expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  parseWorkspaceId,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { visibleArtifactIds } from '../../src/artifacts/references/access.repository.js';
import {
  lockArtifactReferences,
  lockActorArtifactReferences,
} from '../../src/artifacts/references/locks.repository.js';
import { artifactOwnerFixture } from './owner-shapes.fixture.js';
import { ownerTransaction } from './lifetime/fixture.js';
import { workspaceId, userId } from '../lifecycle/retention.support.js';

const authoredOwners = {
  draft:
    'update app.workflow_drafts set graph_json=replace(graph_json::text,$3,$4)::json where workspace_id=$1 and workflow_id=$2',
  version:
    'update app.workflow_versions set graph_json=replace(graph_json::text,$3,$4)::json where workspace_id=$1 and workflow_id=$2',
  snapshot:
    'update app.workflow_test_snapshots set graph_json=replace(graph_json::text,$3,$4)::json where workspace_id=$1 and workflow_id=$2',
  'suite-case':
    'update app.workflow_test_suite_cases set input=replace(input,$3,$4) where workspace_id=$1 and suite_id in (select id from app.workflow_test_suites where workflow_id=$2)',
  'input-case':
    'update app.workflow_input_case_payloads set input=replace(input,$3,$4) where workspace_id=$1 and case_id in (select id from app.workflow_input_cases where workflow_id=$2)',
  'preview-node':
    'update app.preview_runs set executable_node_json=replace(executable_node_json::text,$3,$4)::json where workspace_id=$1 and workflow_id=$2',
};
const cases = Object.entries(authoredOwners).flatMap(([location, statement]) =>
  ['upper', 'mixed'].map((casing) => ({
    location: location as keyof typeof authoredOwners,
    statement,
    casing,
  })),
);
it.each(cases)(
  'protects an admitted $casing identity in $location for access and retention',
  async ({ location, statement, casing }) => {
    const state = await artifactOwnerFixture(location, 'descriptor');
    try {
      const id =
        casing === 'upper'
          ? state.reference.artifactId.toUpperCase()
          : state.reference.artifactId.replace(
              /[a-f]/gu,
              (character, offset: number) =>
                offset % 2 === 0 ? character.toUpperCase() : character,
            );
      const reference = { ...state.reference, artifactId: id };
      await withTenantScopedClient(state.pool, { workspaceId }, (client) =>
        lockArtifactReferences(client, workspaceId, reference, userId),
      );
      await ownerTransaction((client) =>
        client.query(statement, [
          workspaceId,
          state.workflowId,
          state.reference.artifactId,
          id,
        ]),
      );
      const visible = await withTenantScopedClient(
        state.pool,
        { workspaceId },
        (client) =>
          visibleArtifactIds(client, { workspaceId, actorId: userId }, [id]),
      );
      const retained = await state.coordinator.processNext();
      expect([...visible]).toEqual([state.reference.artifactId]);
      expect(retained).toMatchObject({
        status: 'referenced',
        artifactId: state.reference.artifactId,
      });
      expect(state.store.delete).not.toHaveBeenCalled();
    } finally {
      await state.close();
    }
  },
);
it('authorizes repeated actor references by normalized identity without discarding metadata checks', async () => {
  const state = await artifactOwnerFixture('draft', 'descriptor');
  try {
    const references = [
      state.reference,
      {
        ...state.reference,
        artifactId: state.reference.artifactId.toUpperCase(),
      },
    ];
    await expect(
      withTenantScopedClient(state.pool, { workspaceId }, (client) =>
        lockActorArtifactReferences(
          { db: drizzle(client), workspaceId: parseWorkspaceId(workspaceId) },
          userId,
          references,
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      withTenantScopedClient(state.pool, { workspaceId }, (client) =>
        lockActorArtifactReferences(
          { db: drizzle(client), workspaceId: parseWorkspaceId(workspaceId) },
          userId,
          [...references, { ...references[1], byteLength: 5 }],
        ),
      ),
    ).rejects.toMatchObject({ name: 'ArtifactMetadataNotFoundError' });
  } finally {
    await state.close();
  }
});
