import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  afterAllFixture2,
  beforeAllFixture1,
} from '../triggers/forms/admission/fixture.js';
import {
  openUploads,
  uploads,
  admin,
  beginInvoice,
  finalize,
  publicForm,
  readArtifact,
  session,
  store,
  digest,
  memberForm,
  fileFields,
} from './form-uploads/fixture.js';
import {
  FormFileRejectedError,
  FormValuesInvalidError,
  FORM_FILE_LIMITS,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import {
  ArtifactUploadNotFoundError,
  ArtifactQuotaExceededError,
  ArtifactUploadIdempotencyConflictError,
} from '../../src/artifacts/uploads/errors.js';
import {
  FormChangedError,
  FormUnavailableError,
} from '../../src/triggers/forms/errors.js';
import { FormUploadLimitError } from '../../src/artifacts/form-uploads/errors.js';
import { PendingTaskDecisionError } from '../../src/runs/pending-tasks/responses/errors.js';
import { taskFixture, store as tasks } from '../runs/pending-tasks/fixtures.js';
import { userId, apiUrl } from '../lifecycle/retention.support.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createArtifactUploadStore } from '../../src/artifacts/uploads/store.js';

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

async function storedBinding(artifactId: string) {
  const { rows } = await admin.query<{
    uploaded_by: string | null;
    capability_hash: string | null;
  }>(
    'select uploaded_by,capability_hash from app.form_uploads where artifact_id=$1',
    [artifactId],
  );
  return rows[0];
}

beforeAll(() => {
  beforeAllFixture1();
  openUploads();
});
afterAll(async () => {
  await Promise.all([afterAllFixture2(), uploads.close()]);
});
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
  // Unsent public uploads go after an hour.
  expect((await readArtifact(begun.artifact.id))?.hours).toBe(1);
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
it('binds a member form upload to that member', async () => {
  const form = await memberForm();
  const responder = session();
  const begun = await beginInvoice(form, responder);
  await finalize(form, responder, begun);
  const command = {
    workspaceId: form.workspaceId,
    workflowId: form.workflowId,
    versionId: form.versionId,
    values: { invoice: [begun.artifact.id] },
    uploadSession: responder,
  };
  await expect(
    store.submit({
      ...command,
      actorId: form.actorId,
      idempotencyKey: 'other-member',
    }),
  ).rejects.toThrow(FormValuesInvalidError);
  const accepted = await store.submit({
    ...command,
    actorId: form.viewerId,
    idempotencyKey: 'member-files',
  });
  expect(accepted).toMatchObject({ accepted: true });
});

it('uploads through an open input request and returns the files in its response', async () => {
  const f = await taskFixture();
  await admin.query(
    `update app.pending_run_tasks set kind='input_request',config=$2::jsonb where id=$1`,
    [
      f.taskId,
      JSON.stringify(inputRequestConfigSchema.parse({ fields: fileFields })),
    ],
  );
  const target = {
    kind: 'input_request' as const,
    workspaceId: f.workspaceId,
    taskId: f.taskId,
    actorId: userId,
  };
  const responder = session();
  const begun = await beginInvoice({ target }, responder);
  await finalize({ target }, responder, begun);
  // A different member cannot read this response's upload.
  await expect(
    uploads.read({
      target: { ...target, actorId: f.deciderId },
      session: responder,
      uploadId: begun.artifact.id,
    }),
  ).rejects.toThrow(ArtifactUploadNotFoundError);
  const response = await tasks.submit({
    ...f.scope,
    actorId: userId,
    values: { invoice: [begun.artifact.id] },
    idempotencyKey: 'task-files',
    uploadSession: responder,
  });
  expect(response.task).toMatchObject({
    status: 'submitted',
    output: {
      values: {
        invoice: [
          {
            file: { artifactId: begun.artifact.id, kind: 'artifact' },
            filename: 'invoice.pdf',
          },
        ],
      },
    },
  });
  // A resolved task takes no more uploads.
  await expect(beginInvoice({ target }, responder)).rejects.toThrow(
    PendingTaskDecisionError,
  );
});
it('stores a public-link upload against its link, with no member behind it', async () => {
  const form = await publicForm();
  const begun = await beginInvoice(form, session());
  const binding = await storedBinding(begun.artifact.id);
  expect(binding?.uploaded_by).toBeNull();
  expect(binding?.capability_hash).toEqual(expect.any(String));
});

it('gives a member no route to a public-link upload, even with the same session', async () => {
  const form = await publicForm();
  const responder = session();
  const begun = await beginInvoice(form, responder);
  const asMember = {
    target: {
      kind: 'member_form' as const,
      workspaceId: form.workspaceId,
      workflowId: form.workflowId,
      actorId: form.viewerId,
    },
    session: responder,
    uploadId: begun.artifact.id,
  };
  await expect(uploads.read(asMember)).rejects.toBeInstanceOf(
    ArtifactUploadNotFoundError,
  );
  await expect(
    uploads.finalize({ ...asMember, expectedMetadata: begun.artifact }),
  ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
  await expect(
    uploads.read({
      target: form.target,
      session: responder,
      uploadId: begun.artifact.id,
    }),
  ).resolves.toMatchObject({ filename: 'invoice.pdf' });
});

it('gives a public link no route to a member’s upload, even with the same session', async () => {
  const form = await publicForm();
  const responder = session();
  const member = {
    target: {
      kind: 'member_form' as const,
      workspaceId: form.workspaceId,
      workflowId: form.workflowId,
      actorId: form.viewerId,
    },
  };
  const begun = await beginInvoice(
    { ...member, versionId: form.versionId },
    responder,
  );
  await expect(
    uploads.read({
      target: form.target,
      session: responder,
      uploadId: begun.artifact.id,
    }),
  ).rejects.toBeInstanceOf(ArtifactUploadNotFoundError);
});

it('keeps an unsent public-link file out of the member file store', async () => {
  const form = await publicForm();
  const responder = session();
  const begun = await beginInvoice(form, responder);
  await finalize(form, responder, begun);
  const members = createArtifactUploadStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  try {
    const identity = {
      actor: { workspaceId: form.workspaceId, actorId: form.actorId },
      identity: {
        workspaceId: form.workspaceId,
        artifactId: begun.artifact.id,
      },
    };
    await expect(members.getForUpload(identity)).resolves.toBeNull();
    await expect(members.getMetadata(identity)).resolves.toBeNull();
  } finally {
    await members.close();
  }
});

it('refuses a public-link upload while the workspace is suspended, without needing a member to check', async () => {
  const form = await publicForm();
  const responder = session();
  const begun = await beginInvoice(form, responder);
  await admin.query(
    `update app.workspaces set status='suspended' where id=$1`,
    [form.workspaceId],
  );
  try {
    await expect(beginInvoice(form, responder)).rejects.toBeInstanceOf(
      FormUnavailableError,
    );
    await expect(finalize(form, responder, begun)).rejects.toBeInstanceOf(
      FormUnavailableError,
    );
  } finally {
    await admin.query(`update app.workspaces set status='active' where id=$1`, [
      form.workspaceId,
    ]);
  }
});
