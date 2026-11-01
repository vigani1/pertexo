import { randomUUID } from 'node:crypto';

import { expect, it, vi } from 'vitest';

import {
  createRunArtifactRetentionCoordinator,
  maintenanceUrl,
  parseDatabaseConfig,
  runIds,
  workspaceId,
} from '../retention.support.js';
import { readArtifactRetentionState, withOwnerTransaction } from './fixture.js';

type Client = Parameters<Parameters<typeof withOwnerTransaction>[0]>[0];
type Reference = string;

const runId = runIds[0];

async function insertNode(
  client: Client,
  column: 'input_ref' | 'output_ref',
  reference: Reference,
): Promise<void> {
  const id = randomUUID();
  await client.query(
    `insert into app.node_runs
      (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
       status,side_effect_class,${column})
     values($1,$2,$3,'node',$4,'{}','succeeded','safe',$5::json)`,
    [id, workspaceId, runId, `node-${id}`, reference],
  );
}

const OWNERS: readonly (readonly [
  string,
  (client: Client, reference: Reference) => Promise<unknown>,
])[] = [
  [
    "a run's input",
    (client, reference) =>
      client.query(
        `update app.workflow_runs set input_ref=$2::jsonb,
           input_ref_expires_at=created_at+interval '30 days' where id=$1`,
        [runId, reference],
      ),
  ],
  [
    "a step's output",
    (client, reference) => insertNode(client, 'output_ref', reference),
  ],
  [
    "a step's input",
    (client, reference) => insertNode(client, 'input_ref', reference),
  ],
];

/** The bytes of an expired artifact go for good, so a live reference must stop it. */
export function registerKeepsArtifactStillReferenced(): void {
  it.each(OWNERS)(
    'keeps an expired artifact %s still references',
    async (_owner, reference) => {
      const artifactId = randomUUID();
      await withOwnerTransaction(async (client) => {
        await client.query(
          `insert into app.artifacts
            (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
             status,expires_at,finalized_at)
           values($1,$2,'node-output',$3,'application/json',10,$4,
             'available','2026-07-01T00:00:00Z','2026-06-01T00:00:00Z')`,
          [
            artifactId,
            workspaceId,
            `workspaces/${workspaceId}/artifacts/${artifactId}`,
            'a'.repeat(64),
          ],
        );
        await reference(
          client,
          JSON.stringify({ artifactId, kind: 'artifact' }),
        );
      });
      const store = {
        delete: vi.fn(() => Promise.resolve()),
        head: vi.fn().mockResolvedValue(null),
      };
      const coordinator = createRunArtifactRetentionCoordinator(
        parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
        store,
      );
      try {
        await expect(coordinator.processNext()).resolves.toMatchObject({
          artifactId,
          status: 'referenced',
        });

        expect(store.delete).not.toHaveBeenCalled();
        await expect(readArtifactRetentionState(artifactId)).resolves.toEqual({
          status: 'available',
          retryScheduled: true,
        });
      } finally {
        await coordinator.close();
        await withOwnerTransaction((client) =>
          client.query('delete from app.node_runs where workflow_run_id=$1', [
            runId,
          ]),
        );
      }
    },
  );
}
