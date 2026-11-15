import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  closeAuthenticatedArtifactTransferHTTPFixture,
  integrationDescribe,
  prepareAuthenticatedArtifactTransferHTTPFixture,
  fixture,
  parseResponse,
  signedPut,
} from './artifact-transfer.fixture.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine/server';
import {
  FORM_FILE_LIMITS,
  formConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import { formUploadResponseSchema, formUploadSchema } from '@pertexo/contracts';
import { expectProblem, mutationHeaders } from './transfer.support.js';

const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const token = () => randomBytes(32).toString('base64url');

/** Publishes a form with one PDF field and opens it by link. */
async function publicForm() {
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const publicId = randomUUID();
  const capability = token();
  const graph: WorkflowGraph = {
    settings: {},
    nodes: [
      {
        id: 'form',
        definition: { key: 'core.form', version: 1 },
        configVersion: 1,
        config: formConfigSchema.parse({
          fields: [
            {
              id: 'invoice-field',
              name: 'invoice',
              label: 'Invoice',
              type: 'file',
              accept: ['documents'],
              maxBytes: 1_048_576,
            },
          ],
        }),
        position: { x: 0, y: 0 },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await fixture.withOwner(async (client) => {
    await client.query(
      `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Upload form',$3)`,
      [workflowId, fixture.workspaceId, fixture.ownerUserId],
    );
    await client.query(
      `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
       values($1,$2,$3,1,$4::json,$5::json,$6,$7)`,
      [
        versionId,
        fixture.workspaceId,
        workflowId,
        JSON.stringify(graph),
        JSON.stringify(compiled.envelope),
        compiled.checksum,
        fixture.ownerUserId,
      ],
    );
    await client.query(
      `update app.workflows set published_version_id=$2 where id=$1`,
      [workflowId, versionId],
    );
    await client.query(
      `insert into app.workflow_forms(workspace_id,workflow_id,public_id,node_id,access,capability_hash)
       values($1,$2,$3,'form','public',$4)`,
      [
        fixture.workspaceId,
        workflowId,
        publicId,
        createHash('sha256').update(capability).digest('hex'),
      ],
    );
  });
  const session = token();
  const headers = (extra: Readonly<Record<string, string>> = {}) => ({
    'x-pertexo-form-key': capability,
    'x-pertexo-form-session': session,
    ...extra,
  });
  const begin = (
    body: Readonly<Record<string, unknown>>,
    extra: Readonly<Record<string, string>> = {},
  ) =>
    fixture.application.inject({
      method: 'POST',
      url: `/v1/forms/${publicId}/uploads`,
      headers: headers({ 'idempotency-key': randomUUID(), ...extra }),
      payload: { versionId, fieldId: 'invoice-field', ...body },
    });
  const finalize = (uploadId: string) =>
    fixture.application.inject({
      method: 'POST',
      url: `/v1/forms/${publicId}/uploads/${uploadId}/finalize`,
      headers: headers(),
      payload: {},
    });
  const submit = (uploadId: string, suppliedSession: string | null = session) =>
    fixture.application.inject({
      method: 'POST',
      url: `/v1/forms/${publicId}/submit`,
      headers: {
        'x-pertexo-form-key': capability,
        'idempotency-key': randomUUID(),
        ...(suppliedSession === null
          ? {}
          : { 'x-pertexo-form-session': suppliedSession }),
      },
      payload: { versionId, values: { invoice: [uploadId] } },
    });
  return { workflowId, versionId, publicId, begin, finalize, submit };
}

integrationDescribe('form uploads over HTTP and object storage', () => {
  beforeAll(prepareAuthenticatedArtifactTransferHTTPFixture);
  afterAll(closeAuthenticatedArtifactTransferHTTPFixture);
  it('takes a public responder’s file through a bound reservation, a direct PUT and a sniffed finalize', async () => {
    const form = await publicForm();
    const bytes = new TextEncoder().encode('%PDF-1.7\n% invoice\n');
    const begun = await form.begin({
      filename: 'March invoice.pdf',
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
    });
    expect(begun.statusCode, begun.payload).toBe(201);
    expect(begun.headers['referrer-policy']).toBe('no-referrer');
    const reservation = parseResponse(begun, formUploadResponseSchema);
    expect(reservation.upload).toMatchObject({
      filename: 'March invoice.pdf',
      mediaType: 'application/pdf',
      status: 'pending',
    });
    expect((await signedPut(reservation.transfer, bytes)).ok).toBe(true);
    const finalized = await form.finalize(reservation.upload.id);
    expect(finalized.statusCode, finalized.payload).toBe(200);
    expect(parseResponse(finalized, formUploadSchema)).toMatchObject({
      id: reservation.upload.id,
      status: 'available',
    });
    expect(await fixture.readArtifact(reservation.upload.id)).toMatchObject({
      purpose: 'form-upload',
      status: 'available',
    });
    // Repeating finalize is idempotent.
    expect((await form.finalize(reservation.upload.id)).statusCode).toBe(200);
    expect((await form.submit(reservation.upload.id, null)).statusCode).toBe(
      400,
    );
    expect((await form.submit(reservation.upload.id, token())).statusCode).toBe(
      400,
    );
    const submitted = await form.submit(reservation.upload.id);
    expect(submitted.statusCode, submitted.payload).toBe(200);
    expect(submitted.json()).not.toHaveProperty('runId');
    const runs = await fixture.withOwner(
      async (client) =>
        (
          await client.query<{ trigger_type: string; input_ref: unknown }>(
            'select trigger_type,input_ref from app.workflow_runs where workflow_id=$1',
            [form.workflowId],
          )
        ).rows,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger_type: 'form',
      input_ref: {
        value: {
          values: {
            invoice: [
              { file: { kind: 'artifact', artifactId: reservation.upload.id } },
            ],
          },
        },
      },
    });
  });

  it('refuses bytes that are not the type their name claims and keeps them unusable', async () => {
    const form = await publicForm();
    const bytes = new TextEncoder().encode('<html><script>alert(1)</script>');
    const begun = parseResponse(
      await form.begin({
        filename: 'invoice.pdf',
        byteLength: bytes.byteLength,
        sha256: digest(bytes),
      }),
      formUploadResponseSchema,
    );
    expect((await signedPut(begun.transfer, bytes)).ok).toBe(true);
    const refused = await form.finalize(begun.upload.id);
    expectProblem(refused, 415, 'form.file_type_not_allowed');
    expect(refused.json()).toMatchObject({
      detail:
        'This file’s contents don’t match its .pdf name. Choose the original file.',
    });
    expect((await fixture.readArtifact(begun.upload.id))?.status).toBe(
      'pending',
    );
  });

  it('refuses a file the field does not accept before any storage work', async () => {
    const form = await publicForm();
    const before = fixture.readStorageCalls().beginDirectUpload;
    expectProblem(
      await form.begin({
        filename: 'setup.exe',
        byteLength: 4,
        sha256: 'a'.repeat(64),
      }),
      415,
      'form.file_type_not_allowed',
    );
    const tooLarge = await form.begin({
      filename: 'scan.pdf',
      byteLength: 2 * 1_048_576,
      sha256: 'a'.repeat(64),
    });
    expectProblem(tooLarge, 413, 'form.file_too_large');
    expect(tooLarge.json()).toMatchObject({
      detail: 'This file is 2 MB; the limit is 1 MB.',
    });
    expect(fixture.readStorageCalls().beginDirectUpload).toBe(before);
  });

  it('requires the current link and a response session', async () => {
    const form = await publicForm();
    const metadata = {
      filename: 'invoice.pdf',
      byteLength: 4,
      sha256: 'a'.repeat(64),
    };
    expectProblem(
      await form.begin(metadata, { 'x-pertexo-form-key': token() }),
      404,
      'form.unavailable',
    );
    expectProblem(
      await form.begin(metadata, { 'x-pertexo-form-session': 'short' }),
      400,
      'request.invalid',
    );
    expectProblem(
      await form.begin({ ...metadata, versionId: randomUUID() }),
      409,
      'form.changed',
    );
    // A member who cannot reach the form gets nothing either.
    const viewer = await fixture.login('viewer');
    expectProblem(
      await fixture.application.inject({
        method: 'POST',
        url: `/v1/workspaces/${fixture.otherWorkspaceId}/workflows/${form.workflowId}/form/uploads`,
        headers: mutationHeaders(viewer, randomUUID(), {
          'x-pertexo-form-session': token(),
        }),
        payload: {
          versionId: form.versionId,
          fieldId: 'invoice-field',
          ...metadata,
        },
      }),
      404,
      'resource.not_found',
    );
  });

  // web-app-13: the busy allowance gets its own temporary code.
  it('asks public responders to wait while unsent link files fill the allowance', async () => {
    const form = await publicForm();
    const held = randomUUID();
    await fixture.withOwner(async (client) => {
      await client.query(
        `insert into app.artifacts
           (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
            status,expires_at)
         values($1,$2,'form-upload',$3,'application/pdf',$4,$5,
           'pending',clock_timestamp()+interval '15 minutes')`,
        [
          held,
          fixture.workspaceId,
          `workspaces/${fixture.workspaceId}/artifacts/${held}`,
          FORM_FILE_LIMITS.unsentPublicBytes,
          'f'.repeat(64),
        ],
      );
      await client.query(
        `insert into app.form_uploads
           (workspace_id,artifact_id,workflow_id,workflow_version_id,field_id,
            filename,session_hash,capability_hash)
         values($1,$2,$3,$4,'invoice-field','held.pdf',$5,$6)`,
        [
          fixture.workspaceId,
          held,
          form.workflowId,
          form.versionId,
          'a'.repeat(64),
          'b'.repeat(64),
        ],
      );
    });
    try {
      const refused = await form.begin({
        filename: 'invoice.pdf',
        byteLength: 4,
        sha256: 'a'.repeat(64),
      });
      expectProblem(refused, 429, 'form.upload_busy');
      expect(refused.json()).toMatchObject({
        detail:
          'This form is receiving a lot of files right now. Try again in a few minutes.',
      });
    } finally {
      // Releasing the charge goes through deleting, as cleanup does.
      await fixture.withOwner(async (client) => {
        await client.query(
          `update app.artifacts set status='deleting' where id=$1`,
          [held],
        );
        await client.query(`delete from app.artifacts where id=$1`, [held]);
      });
    }
  });
  it('gives expired and missing form finalizations the same safe upload-again message', async () => {
    const form = await publicForm();
    const bytes = new TextEncoder().encode('%PDF-1.7\n');
    const begun = await form.begin({
      filename: 'invoice.pdf',
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
    });
    expect(begun.statusCode, begun.payload).toBe(201);
    const reservation = parseResponse(begun, formUploadResponseSchema);
    await fixture.expireArtifact(reservation.upload.id);
    for (const id of [reservation.upload.id, randomUUID()]) {
      const refused = await form.finalize(id);
      expectProblem(refused, 404, 'artifact.upload_unavailable');
      expect(refused.json()).toMatchObject({
        detail:
          'This upload expired or is no longer available. Upload the file again.',
      });
    }
  });
});
