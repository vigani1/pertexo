import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseSchema } from '@pertexo/database/schema';
import {
  parseWorkspaceId,
  withTenantScopedClient,
  type WorkspaceTransaction,
} from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { ArtifactMetadataNotFoundError } from '../../src/artifacts/errors.js';
import {
  artifactStorageKey,
  createPendingPreviewArtifact,
} from '../../src/artifacts/records.repository.js';
import {
  lockExecutionArtifactReferences,
  requireNodeArtifactReference,
} from '../../src/artifacts/references/locks.repository.js';
import { serializeStoredExecutionValue } from '../../src/runs/values/stored-execution.js';
import {
  acceptFixture,
  actorUserId,
  scopedQuery,
  withOwnerRole,
  workerPool,
  workflowId,
  workspaceId,
} from './worker.fixture.js';

const MARKER = 'isolation-canary-5c1d';

const inWorkspace = <T>(
  work: (transaction: WorkspaceTransaction) => Promise<T>,
) =>
  withTenantScopedClient(workerPool, { workspaceId }, (client) =>
    work({
      db: drizzle(client, { schema: databaseSchema }),
      workspaceId: parseWorkspaceId(workspaceId),
    }),
  );

const count = async (table: string, where: string, values: unknown[]) => {
  const { rows } = await scopedQuery<{ count: string }>(
    `select count(*)::text as count from app.${table} where ${where}`,
    values,
  );
  return Number(rows[0]?.count);
};

const asOwner = <T>(work: (client: PoolClient) => Promise<T>) =>
  withOwnerRole(async (client) => {
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    return work(client);
  });

/** An artifact a preview wrote, available to read. */
async function previewArtifact(previewRunId: string) {
  const artifactId = randomUUID();
  const reference = {
    artifactId,
    byteLength: 3,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  };
  await inWorkspace((transaction) =>
    createPendingPreviewArtifact(transaction, {
      ...reference,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      previewRunId,
      purpose: 'node-output',
      storageKey: artifactStorageKey(workspaceId, artifactId),
    }),
  );
  await asOwner((client) =>
    client.query(
      "update app.artifacts set status='available',finalized_at=clock_timestamp() where id=$1",
      [artifactId],
    ),
  );
  return reference;
}

async function otherWorkflow(): Promise<string> {
  const id = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Other',$3)",
      [id, workspaceId, actorUserId],
    );
    await client.query(
      `insert into app.workflow_drafts(workflow_id,workspace_id,revision,graph_json,updated_by)
       values($1,$2,3,'{"nodes":[],"edges":[],"settings":{}}',$3)`,
      [id, workspaceId, actorUserId],
    );
  });
  return id;
}

const scoped = (id: string) => ({
  workflowId: id,
  scope: `${actorUserId}:${id}`,
});
const keys = () => ({
  keyHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
  requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
});

describe('what a preview keeps to itself', () => {
  it("lets a preview read its own artifact, and a real run can't read it", async () => {
    const { previewRunId } = await acceptFixture(keys());
    const reference = await previewArtifact(previewRunId);

    await expect(
      inWorkspace((transaction) =>
        requireNodeArtifactReference(transaction, reference, previewRunId),
      ),
    ).resolves.toBeUndefined();
    await expect(
      inWorkspace((transaction) =>
        requireNodeArtifactReference(transaction, reference),
      ),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
    // What a real run's acceptance does with the input it's given.
    await expect(
      inWorkspace((transaction) =>
        lockExecutionArtifactReferences(transaction, {
          attached: { kind: 'artifact', ...reference },
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
  });

  it("keeps a preview of another workflow out of this one's artifact", async () => {
    const { previewRunId } = await acceptFixture(keys());
    const reference = await previewArtifact(previewRunId);
    const elsewhere = await otherWorkflow();
    const other = await acceptFixture({ ...keys(), ...scoped(elsewhere) });

    await expect(
      inWorkspace((transaction) =>
        requireNodeArtifactReference(
          transaction,
          reference,
          other.previewRunId,
        ),
      ),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
  });

  it("refuses a new preview that names another preview's artifact, in its input or its step, and writes nothing", async () => {
    const { previewRunId } = await acceptFixture(keys());
    const reference = await previewArtifact(previewRunId);
    const attached = { kind: 'artifact', ...reference };
    const before = await count('preview_runs', 'workspace_id=$1', [
      workspaceId,
    ]);

    await expect(
      acceptFixture({
        ...keys(),
        input: { kind: 'manual', value: { attached } },
      }),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);
    await expect(
      acceptFixture({
        ...keys(),
        executableNode: {
          id: 'http',
          config: { attached },
          connectionRefs: {},
        },
      }),
    ).rejects.toBeInstanceOf(ArtifactMetadataNotFoundError);

    expect(await count('preview_runs', 'workspace_id=$1', [workspaceId])).toBe(
      before,
    );
  });

  it('lets the next step of the same workflow use a prior output, as testing step by step needs', async () => {
    const first = await acceptFixture(keys());
    const reference = await previewArtifact(first.previewRunId);
    await asOwner(async (client) => {
      const output = serializeStoredExecutionValue({
        kind: 'inline',
        value: { attached: { kind: 'artifact', ...reference } },
      });
      await client.query(
        `update app.preview_attempts set status='succeeded',started_at=now(),completed_at=now(),output_ref=$2::jsonb where id=$1`,
        [first.previewAttemptId, output],
      );
      await client.query(
        `update app.preview_runs set status='succeeded',started_at=now(),completed_at=now(),output_ref=$2::jsonb where id=$1`,
        [first.previewRunId, output],
      );
    });

    const second = await acceptFixture({
      ...keys(),
      input: { kind: 'prior_preview', previewRunId: first.previewRunId },
    });

    await expect(
      inWorkspace((transaction) =>
        requireNodeArtifactReference(
          transaction,
          reference,
          second.previewRunId,
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("leaves no trace in a real run's tables, and sends its values nowhere", async () => {
    const before = {
      runs: await count('workflow_runs', 'workflow_id=$1', [workflowId]),
      events: await count('run_events', 'workspace_id=$1', [workspaceId]),
    };

    const { previewRunId, outboxEventId } = await acceptFixture({
      ...keys(),
      input: { kind: 'manual', value: { secretish: MARKER } },
    });

    expect({
      runs: await count('workflow_runs', 'workflow_id=$1', [workflowId]),
      events: await count('run_events', 'workspace_id=$1', [workspaceId]),
    }).toEqual(before);
    const { rows: stored } = await scopedQuery<{ input: unknown }>(
      'select input_ref as input from app.preview_runs where id=$1',
      [previewRunId],
    );
    expect(JSON.stringify(stored)).toContain(MARKER);
    const { rows: outbox } = await scopedQuery<{ payload: unknown }>(
      'select payload from app.outbox_events where id=$1',
      [outboxEventId],
    );
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox)).not.toContain(MARKER);
  });

  it("refuses a connection that isn't this workspace's, and writes nothing", async () => {
    const before = await count('preview_runs', 'workspace_id=$1', [
      workspaceId,
    ]);
    await expect(
      acceptFixture({
        ...keys(),
        executableNode: {
          id: 'http',
          config: {},
          connectionRefs: { auth: randomUUID() },
        },
      }),
    ).rejects.toThrow();
    expect(await count('preview_runs', 'workspace_id=$1', [workspaceId])).toBe(
      before,
    );
  });
});
