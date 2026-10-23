import { vi } from 'vitest';
import { EMPTY_WORKFLOW_GRAPH } from '@pertexo/workflow-model';

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
} from '../../lifecycle/retention.support.js';

export function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

export async function ownerTransaction<T>(
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

export async function fixture(shape: 'literal' | 'multipart') {
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

export async function addVersion(
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

export const shapes = ['literal', 'multipart'] as const;
