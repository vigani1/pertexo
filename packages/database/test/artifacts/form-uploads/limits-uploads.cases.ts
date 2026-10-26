import { expect, it } from 'vitest';
import { FORM_FILE_LIMITS } from '@pertexo/workflow-model';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadIdempotencyConflictError,
} from '../../../src/artifacts/uploads/input.js';
import { FormUploadLimitError } from '../../../src/artifacts/form-uploads/errors.js';
import { admin, beginInvoice, digest, publicForm, session } from './fixture.js';

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
}
