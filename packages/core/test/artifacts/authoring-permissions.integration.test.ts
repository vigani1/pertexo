import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  parseWorkflowGraphDraft,
  projectWorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { ArtifactMetadataNotFoundError } from '../../src/artifacts/artifact.errors.js';
import { createArtifactUploadStore } from '../../src/artifacts/uploads/artifact-upload.store.js';
import { createWorkflowInputCaseStore } from '../../src/authoring/input-cases/workflow-input-case.store.js';
import {
  apiUrl,
  authoring,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  queryAsOwner,
  workspaceId,
} from '../support/workflow-authoring.js';
import {
  beforeAllFixture1,
  afterAllFixture2,
  builder,
  privateRun,
  publicId,
} from '../tenant-access/resources/folders/fixture.js';
import {
  afterEachFixture1 as closeImports,
  command as importCommand,
  database as importDatabase,
  portableCatalog,
} from '../authoring/workflows/portability.fixture.js';
import {
  fixture as sampleWorkflow,
  testIntent,
} from '../authoring/samples/step-sample.fixture.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
afterAll(closeImports);

it.each([
  'create workflow',
  'create input case',
  'update input case',
  'preview input',
  'preview config',
  'import',
] as const)(
  'refuses a restricted file through %s without creating a readable owner',
  async (entry) => {
    const file = await restrictedFile();
    const config = parseDatabaseConfig({ connectionString: apiUrl, max: 2 });
    const files = createArtifactUploadStore(config);
    const cases = createWorkflowInputCaseStore(config);
    const metadata = () =>
      files.getMetadata({
        actor: { workspaceId, actorId: builder },
        identity: { workspaceId, artifactId: file.artifactId },
      });
    try {
      expect(await metadata()).toBeNull();
      let attempt: () => Promise<unknown>;
      if (entry === 'create workflow') {
        attempt = () =>
          authoring.createWorkflow({
            actorId: builder,
            workspaceId,
            name: 'Forbidden file',
            emptyGraph: { ...emptyGraph, nodes: [draftNode('file', { file })] },
            idempotencyKey: randomUUID(),
          });
      } else if (
        entry === 'create input case' ||
        entry === 'update input case'
      ) {
        const version = await query(
          'select id from app.workflow_versions where workflow_id=$1',
          [publicId],
        );
        const command = {
          workspaceId,
          actorId: builder,
          workflowId: publicId,
          workflowVersionId: String(version[0]?.id),
          name: 'File case',
          idempotencyKey: randomUUID(),
          input: { file },
        };
        if (entry === 'create input case')
          attempt = () => cases.createCase(command);
        else {
          const original = await cases.createCase({
            ...command,
            input: { allowed: true },
          });
          attempt = () =>
            cases.updateCase({
              ...command,
              ...original,
              expectedRevision: original.revision,
              idempotencyKey: randomUUID(),
            });
        }
      } else if (entry === 'preview input' || entry === 'preview config') {
        const f = await sampleWorkflow();
        const intent = {
          ...testIntent(f, ''),
          actorUserId: builder,
          expectedSampleId: null,
        };
        attempt = () =>
          authoring.acceptPreview({
            ...intent,
            ...(entry === 'preview input'
              ? { input: { kind: 'manual' as const, value: { file } } }
              : {
                  executableNode: {
                    ...intent.executableNode,
                    config: { file },
                  },
                }),
          });
      } else {
        const db = importDatabase();
        const manifest = projectWorkflowPortableManifest(
          parseWorkflowGraphDraft({
            ...emptyGraph,
            nodes: [draftNode('file', { file })],
          }),
          portableCatalog,
        );
        attempt = () =>
          db.importWorkflow(importCommand({ actorId: builder, manifest }));
      }
      const before = await ownershipFacts();
      await expect(attempt()).rejects.toBeInstanceOf(
        ArtifactMetadataNotFoundError,
      );
      expect(await ownershipFacts()).toEqual(before);
      expect(await metadata()).toBeNull();
    } finally {
      await Promise.all([files.close(), cases.close()]);
    }
  },
);

async function restrictedFile() {
  const file = {
    kind: 'artifact' as const,
    artifactId: randomUUID(),
    byteLength: 4,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  };
  await query(
    `insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at)
    values($1,$2,'run-output',$3,$4,4,$5,'available',clock_timestamp()+interval '1 day',clock_timestamp())`,
    [
      file.artifactId,
      workspaceId,
      `workspaces/${workspaceId}/artifacts/${file.artifactId}`,
      file.mediaType,
      file.sha256,
    ],
  );
  await query('update app.workflow_runs set output_ref=$2 where id=$1', [
    privateRun,
    JSON.stringify({ kind: 'inline', value: { file } }),
  ]);
  return file;
}

function ownershipFacts() {
  return query(
    `select
    (select count(*)::int from app.workflows where workspace_id=$1) workflows,
    (select count(*)::int from app.workflow_input_cases where workspace_id=$1) cases,
    (select coalesce(jsonb_agg(input order by case_id),'[]') from app.workflow_input_case_payloads where workspace_id=$1) inputs,
    (select count(*)::int from app.preview_runs where workspace_id=$1) previews,
    (select count(*)::int from app.idempotency_records where workspace_id=$1) receipts,
    (select count(*)::int from app.audit_events where workspace_id=$1) audits`,
    [workspaceId],
  );
}

function query(statement: string, values: readonly unknown[]) {
  return queryAsOwner(statement, values, workspaceId);
}
