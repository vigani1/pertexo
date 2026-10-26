import { expect, it } from 'vitest';
import {
  FormValuesInvalidError,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/input.js';
import { PendingTaskDecisionError } from '../../../src/runs/pending-tasks/responses/errors.js';
import {
  taskFixture,
  store as tasks,
} from '../../runs/pending-tasks/fixtures.js';
import { userId } from '../../lifecycle/retention.support.js';
import {
  admin,
  beginInvoice,
  fileFields,
  finalize,
  memberForm,
  session,
  store,
  uploads,
} from './fixture.js';

export function registerBindsMemberAndTaskUploads(): void {
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
}
