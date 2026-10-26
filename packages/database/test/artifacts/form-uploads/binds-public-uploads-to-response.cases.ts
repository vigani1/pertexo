import { expect, it } from 'vitest';
import {
  FormFileRejectedError,
  FormValuesInvalidError,
} from '@pertexo/workflow-model';
import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/input.js';
import {
  FormChangedError,
  FormUnavailableError,
} from '../../../src/triggers/forms/errors.js';
import {
  admin,
  beginInvoice,
  finalize,
  publicForm,
  readArtifact,
  session,
  store,
  uploads,
} from './fixture.js';

export function registerBindsPublicUploadsToResponse(): void {
  it('admits a public response with the files it uploaded, as file references with their names', async () => {
    const form = await publicForm();
    const responder = session();
    const begun = await beginInvoice(form, responder, {
      filename: 'C:\\fakepath\\Invoice March.PDF',
    });
    expect(begun.filename).toBe('Invoice March.PDF');
    expect(await readArtifact(begun.artifact.id)).toMatchObject({
      status: 'pending',
      purpose: 'form-upload',
      media_type: 'application/pdf',
    });
    const ready = await finalize(form, responder, begun);
    expect(ready.artifact.status).toBe('available');
    // Unsubmitted uploads expire after a day.
    expect((await readArtifact(begun.artifact.id))?.hours).toBe(24);
    const command = {
      workspaceId: form.workspaceId,
      workflowId: form.workflowId,
      versionId: form.versionId,
      values: { invoice: [begun.artifact.id.toUpperCase()] },
      idempotencyKey: 'public-files',
      uploadSession: responder,
    };
    const accepted = await store.submit(command, form.grant);
    expect(accepted).toMatchObject({ accepted: true, replayed: false });
    expect(await store.submit(command, form.grant)).toMatchObject({
      replayed: true,
    });
    const run = await admin.query<{ input_ref: unknown }>(
      `select input_ref from app.workflow_runs where workflow_id=$1`,
      [form.workflowId],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]?.input_ref).toMatchObject({
      value: {
        values: {
          invoice: [
            {
              file: {
                kind: 'artifact',
                artifactId: begun.artifact.id,
                byteLength: 9,
                mediaType: 'application/pdf',
                sha256: begun.artifact.sha256,
              },
              filename: 'Invoice March.PDF',
            },
          ],
        },
        submittedBy: null,
      },
    });
  });

  it('refuses uploads another response, field, link or version began, and unfinished or expired ones', async () => {
    const form = await publicForm();
    const responder = session();
    const submit = (values: Record<string, unknown>, uploadSession?: string) =>
      store.submit(
        {
          workspaceId: form.workspaceId,
          workflowId: form.workflowId,
          versionId: form.versionId,
          values,
          idempotencyKey: crypto.randomUUID(),
          ...(uploadSession === undefined ? {} : { uploadSession }),
        },
        form.grant,
      );
    const pending = await beginInvoice(form, responder);
    await expect(
      submit({ invoice: [pending.artifact.id] }, responder),
    ).rejects.toThrow(FormValuesInvalidError);
    await finalize(form, responder, pending);
    // Another responder, or none, cannot use this upload.
    await expect(
      submit({ invoice: [pending.artifact.id] }, session()),
    ).rejects.toMatchObject({
      fields: [
        {
          name: 'invoice',
          message:
            'A file is no longer available. Remove it and upload it again.',
        },
      ],
    });
    await expect(submit({ invoice: [pending.artifact.id] })).rejects.toThrow(
      FormValuesInvalidError,
    );
    // Its field is fixed when the upload begins.
    await expect(
      submit(
        { invoice: [pending.artifact.id], photos: [pending.artifact.id] },
        responder,
      ),
    ).rejects.toThrow(FormValuesInvalidError);
    // Nobody else can finalize or read it either.
    await expect(
      uploads.read({
        target: form.target,
        session: session(),
        uploadId: pending.artifact.id,
      }),
    ).rejects.toThrow(ArtifactUploadNotFoundError);
    // An expired upload is gone for submission even before cleanup runs.
    await admin.query(
      `update app.artifacts set expires_at=clock_timestamp()-interval '1 second' where id=$1`,
      [pending.artifact.id],
    );
    await expect(
      submit({ invoice: [pending.artifact.id] }, responder),
    ).rejects.toThrow(FormValuesInvalidError);
  });

  it('checks the field, version and link before reserving any storage', async () => {
    const form = await publicForm();
    const responder = session();
    const count = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            `select count(*) n from app.artifacts where workspace_id=$1`,
            [form.workspaceId],
          )
        ).rows[0]?.n,
      );
    const before = await count();
    await expect(
      beginInvoice(form, responder, { filename: 'run.exe' }),
    ).rejects.toThrow(
      new FormFileRejectedError(
        'type',
        'This field accepts PDF, Word and text files.',
      ),
    );
    await expect(
      beginInvoice(form, responder, {
        fieldId: 'photos-field',
        filename: 'photo.png',
        byteLength: 2 * 1_048_576,
      }),
    ).rejects.toThrow('This file is 2 MB; the limit is 1 MB.');
    await expect(
      beginInvoice(form, responder, { fieldId: 'missing-field' }),
    ).rejects.toThrow(FormValuesInvalidError);
    await expect(
      beginInvoice(form, responder, { versionId: crypto.randomUUID() }),
    ).rejects.toThrow(FormChangedError);
    expect(await count()).toBe(before);
    const begun = await beginInvoice(form, responder);
    // Regenerating the link revokes uploads begun through the old one.
    await store.setAccess({
      workspaceId: form.workspaceId,
      workflowId: form.workflowId,
      actorId: form.actorId,
      access: 'public',
      expectedRevision: 1,
      capability: 'B'.repeat(43),
      idempotencyKey: 'rotate',
    });
    await expect(finalize(form, responder, begun)).rejects.toThrow(
      FormUnavailableError,
    );
    await expect(beginInvoice(form, responder)).rejects.toThrow(
      FormUnavailableError,
    );
  });
}
