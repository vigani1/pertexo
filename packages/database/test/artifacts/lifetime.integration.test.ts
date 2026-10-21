import { describe, expect, it, vi } from 'vitest';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';
import {
  lockArtifactReferences,
  requireNodeArtifactReference,
} from '../../src/artifacts/references.js';
import { ArtifactMetadataNotFoundError } from '../../src/artifacts/store.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../src/tenant-access/transactions.js';
import {
  Pool,
  owner,
  workspaceId,
  userId,
  randomUUID,
  maintenanceUrl,
  apiUrl,
  parseDatabaseConfig,
  createRunArtifactRetentionCoordinator,
} from '../lifecycle/retention.support.js';

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
async function ownerTransaction<T>(
  work: (client: typeof owner) => Promise<T>,
): Promise<T> {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(owner);
    await owner.query('commit');
    return result;
  } catch (error) {
    await owner.query('rollback');
    throw error;
  }
}
async function fixture(shape: 'literal' | 'multipart') {
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const artifactId = randomUUID();
  const reference = {
    kind: 'artifact',
    artifactId,
    byteLength: 4,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  };
  const partKey = 'part_22222222-2222-4222-8222-222222222222';
  const graph = {
    ...EMPTY_WORKFLOW_GRAPH,
    nodes: [
      {
        id: 'file',
        definition: {
          key: shape === 'multipart' ? 'http.request' : 'core.set',
          version: 1,
        },
        configVersion: 1,
        config:
          shape === 'multipart'
            ? {
                multipart: {
                  parts: [{ inputKey: partKey, name: 'file', kind: 'file' }],
                },
              }
            : {},
        connectionRefs: {},
        inputMappings: {
          [shape === 'multipart' ? partKey : 'file']: {
            kind: 'literal',
            value: reference,
          },
        },
      },
    ],
  };
  await ownerTransaction(async (client) => {
    await client.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'File lifetime',$3)",
      [workflowId, workspaceId, userId],
    );
    await client.query(
      'insert into app.workflow_drafts(workflow_id,workspace_id,revision,graph_json,updated_by) values($1,$2,1,$3::jsonb,$4)',
      [workflowId, workspaceId, JSON.stringify(EMPTY_WORKFLOW_GRAPH), userId],
    );
    await client.query(
      "insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at) values($1,$2,'user-upload',$3,'application/octet-stream',4,$4,'available',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '31 days')",
      [
        artifactId,
        workspaceId,
        `workspaces/${workspaceId}/artifacts/${artifactId}`,
        reference.sha256,
      ],
    );
  });
  const store = {
    delete: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockResolvedValue(null),
  };
  const coordinator = createRunArtifactRetentionCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    store,
  );
  const pool = new Pool({ connectionString: apiUrl, max: 2 });
  return {
    workflowId,
    versionId,
    reference,
    graph,
    store,
    coordinator,
    pool,
    clear: async () => {
      await ownerTransaction(async (client) => {
        await client.query(
          'delete from app.workflow_input_case_payloads where workspace_id=$1 and case_id in (select id from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2)',
          [workspaceId, workflowId],
        );
        await client.query(
          'delete from app.workflow_input_cases where workspace_id=$1 and workflow_id=$2',
          [workspaceId, workflowId],
        );
        await client.query(
          'delete from app.workflow_versions where workspace_id=$1 and workflow_id=$2',
          [workspaceId, workflowId],
        );
        await client.query(
          'delete from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
          [workspaceId, workflowId],
        );
        await client.query(
          'update app.artifacts set retention_retry_at=null where workspace_id=$1 and id=$2',
          [workspaceId, artifactId],
        );
      });
    },
    close: async () => {
      await coordinator.close();
      await pool.end();
    },
  };
}
async function addVersion(
  state: Awaited<ReturnType<typeof fixture>>,
  graph: unknown = EMPTY_WORKFLOW_GRAPH,
) {
  await ownerTransaction((client) =>
    client.query(
      'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,1,$4::jsonb,$5,$6::jsonb,$7)',
      [
        state.versionId,
        workspaceId,
        state.workflowId,
        JSON.stringify(graph),
        'wf:sha256:' + 'a'.repeat(64),
        '{}',
        userId,
      ],
    ),
  );
}
const shapes = ['literal', 'multipart'] as const;
describe.each(shapes)('artifact lifetime and cleanup (%s)', (shape) => {
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
});
