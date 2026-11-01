import { expect, it } from 'vitest';
import { FORM_FILE_LIMITS } from '@pertexo/workflow-model';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadIdempotencyConflictError,
} from '../../../src/artifacts/uploads/errors.js';
import { FormUploadLimitError } from '../../../src/artifacts/form-uploads/errors.js';
import {
  admin,
  beginInvoice,
  digest,
  finalize,
  memberForm,
  publicForm,
  readArtifact,
  session,
  store,
} from './fixture.js';

const FILE_BYTES = FORM_FILE_LIMITS.defaultMaxBytes;
const FILES_THAT_FIT = FORM_FILE_LIMITS.unsentPublicBytes / FILE_BYTES;

/** Public-link files from separate responses until the unsent allowance is full. */
async function fillUnsentAllowance(
  form: Awaited<ReturnType<typeof publicForm>>,
) {
  const begun = [];
  for (let index = 0; index < FILES_THAT_FIT; index++) {
    const responder = session();
    const idempotencyKey = `unsent-${String(index)}`;
    begun.push({
      responder,
      idempotencyKey,
      upload: await beginInvoice(form, responder, {
        byteLength: FILE_BYTES,
        sha256: digest(idempotencyKey),
        idempotencyKey,
      }),
    });
  }
  return begun;
}

export function registerLimitsUploads(): void {
  it('replays an exact begin and refuses a changed one with the same key', async () => {
    const form = await publicForm();
    const responder = session();
    const first = await beginInvoice(form, responder, {
      idempotencyKey: 'same',
    });
    const again = await beginInvoice(form, responder, {
      idempotencyKey: 'same',
    });
    expect(again).toMatchObject({ replayed: true, filename: 'invoice.pdf' });
    expect(again.artifact.id).toBe(first.artifact.id);
    await expect(
      beginInvoice(form, responder, {
        idempotencyKey: 'same',
        filename: 'other.pdf',
      }),
    ).rejects.toThrow(ArtifactUploadIdempotencyConflictError);
  });

  it('caps the uploads one response may begin', async () => {
    const form = await publicForm();
    const responder = session();
    for (let index = 0; index < FORM_FILE_LIMITS.sessionUploads; index++)
      await beginInvoice(form, responder, {
        sha256: digest(String(index)),
      });
    await expect(beginInvoice(form, responder)).rejects.toThrow(
      FormUploadLimitError,
    );
    // Another response is unaffected.
    await expect(beginInvoice(form, session())).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('charges the workspace quota and refuses uploads beyond it', async () => {
    const form = await publicForm();
    await admin.query(
      `insert into app.workspace_artifact_capacity(workspace_id,byte_limit)
       values($1,20) on conflict (workspace_id) do update set byte_limit=20`,
      [form.workspaceId],
    );
    await beginInvoice(form, session(), { byteLength: 15 });
    await expect(
      beginInvoice(form, session(), { byteLength: 15 }),
    ).rejects.toThrow(ArtifactQuotaExceededError);
  });

  it('caps the bytes of public-link files nobody has sent, per workspace', async () => {
    const form = await publicForm();
    const [first] = await fillUnsentAllowance(form);
    const refusal = beginInvoice(form, session(), { byteLength: FILE_BYTES });
    await expect(refusal).rejects.toThrow(FormUploadLimitError);
    await expect(refusal).rejects.toMatchObject({ reason: 'unsent_public' });
    // An exact retry of an earlier begin still replays.
    if (first === undefined) throw new Error('No upload began');
    await expect(
      beginInvoice(form, first.responder, {
        byteLength: FILE_BYTES,
        sha256: first.upload.artifact.sha256,
        idempotencyKey: first.idempotencyKey,
      }),
    ).resolves.toMatchObject({ replayed: true });
    // Members of the workspace aren't held to it.
    const member = await memberForm();
    await expect(
      beginInvoice(member, session(), { byteLength: FILE_BYTES }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('frees the allowance when a form is sent or its files expire', async () => {
    const form = await publicForm();
    const [sent, expired] = await fillUnsentAllowance(form);
    if (sent === undefined || expired === undefined)
      throw new Error('No upload began');
    await finalize(form, sent.responder, sent.upload);
    await expect(
      store.submit(
        {
          workspaceId: form.workspaceId,
          workflowId: form.workflowId,
          versionId: form.versionId,
          values: { invoice: [sent.upload.artifact.id] },
          idempotencyKey: 'sent-frees-room',
          uploadSession: sent.responder,
        },
        form.grant,
      ),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      beginInvoice(form, session(), { byteLength: FILE_BYTES }),
    ).resolves.toMatchObject({ replayed: false });
    await admin.query(
      `update app.artifacts set expires_at=clock_timestamp()-interval '1 second'
       where id=$1`,
      [expired.upload.artifact.id],
    );
    await expect(
      beginInvoice(form, session(), { byteLength: FILE_BYTES }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('keeps an unsent member file for a day and a public-link one for an hour', async () => {
    const member = await memberForm();
    const memberResponder = session();
    const memberUpload = await beginInvoice(member, memberResponder);
    await finalize(member, memberResponder, memberUpload);
    expect((await readArtifact(memberUpload.artifact.id))?.hours).toBe(24);
    const form = await publicForm();
    const responder = session();
    const upload = await beginInvoice(form, responder);
    await finalize(form, responder, upload);
    expect((await readArtifact(upload.artifact.id))?.hours).toBe(1);
  });
}
