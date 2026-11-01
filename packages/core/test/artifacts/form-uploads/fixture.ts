import { createHash, randomBytes } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createFormUploadDatabase } from '../../../src/artifacts/form-uploads/repository.js';
import type { FormUploadTarget } from '../../../src/artifacts/form-uploads/contract.js';
import { admin } from '../../lifecycle/calls/fixtures.js';
import { apiUrl } from '../../lifecycle/retention.support.js';
import { fixture, store } from '../../triggers/forms/admission/fixture.js';

export { admin, store };
export let uploads: ReturnType<typeof createFormUploadDatabase>;

export function openUploads() {
  uploads = createFormUploadDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
  );
}

export const fileFields = [
  {
    id: 'invoice-field',
    name: 'invoice',
    label: 'Invoice',
    type: 'file' as const,
    accept: ['documents' as const],
  },
  {
    id: 'photos-field',
    name: 'photos',
    label: 'Photos',
    type: 'file' as const,
    required: false,
    accept: ['images' as const],
    maxFiles: 2,
    maxBytes: 1_048_576,
  },
];

export const session = () => randomBytes(32).toString('base64url');
export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** A published form with two file fields, open by public link. */
export async function publicForm() {
  const f = await fixture({ fields: fileFields });
  const capability = randomBytes(32).toString('base64url');
  const access = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: 0,
    capability,
    idempotencyKey: `enable-${capability}`,
  });
  if (access.publicId === null) throw new Error('Public identity missing');
  const grant = await store.discover({ publicId: access.publicId, capability });
  const target: FormUploadTarget = { kind: 'public_form', grant };
  return { ...f, grant, capability, publicId: access.publicId, target };
}

export async function memberForm() {
  const f = await fixture({ fields: fileFields });
  const target: FormUploadTarget = {
    kind: 'member_form',
    workspaceId: f.workspaceId,
    workflowId: f.workflowId,
    actorId: f.viewerId,
  };
  return { ...f, target };
}

export function beginInvoice(
  form: Readonly<{ target: FormUploadTarget; versionId?: string }>,
  responder: string,
  overrides: Partial<Parameters<typeof uploads.begin>[0]> = {},
) {
  return uploads.begin({
    target: form.target,
    session: responder,
    ...(form.versionId === undefined ? {} : { versionId: form.versionId }),
    fieldId: 'invoice-field',
    filename: 'invoice.pdf',
    byteLength: 9,
    sha256: digest('%PDF-1.7\n'),
    idempotencyKey: randomBytes(8).toString('hex'),
    ...overrides,
  });
}

/** Stands in for verified bytes: finalization only flips the lifecycle. */
export function finalize(
  form: Readonly<{ target: FormUploadTarget }>,
  responder: string,
  upload: Awaited<ReturnType<typeof beginInvoice>>,
) {
  return uploads.finalize({
    target: form.target,
    session: responder,
    uploadId: upload.artifact.id,
    expectedMetadata: upload.artifact,
  });
}

export async function readArtifact(id: string) {
  const result = await admin.query<{
    status: string;
    purpose: string;
    media_type: string;
    hours: number;
  }>(
    `select status,purpose,media_type,
       round(extract(epoch from expires_at-clock_timestamp())/3600)::int hours
     from app.artifacts where id=$1`,
    [id],
  );
  return result.rows[0];
}
