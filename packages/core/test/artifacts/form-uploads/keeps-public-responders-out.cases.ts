import { parseDatabaseConfig } from '@pertexo/database/platform';
import { expect, it } from 'vitest';

import { createArtifactUploadStore } from '../../../src/artifacts/uploads/store.js';
import { ArtifactUploadNotFoundError } from '../../../src/artifacts/uploads/errors.js';
import { FormUnavailableError } from '../../../src/triggers/forms/errors.js';
import { apiUrl } from '../../lifecycle/retention.support.js';
import {
  admin,
  beginInvoice,
  finalize,
  publicForm,
  session,
  uploads,
} from './fixture.js';

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

export function registerKeepsPublicRespondersOut(): void {
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
      await admin.query(
        `update app.workspaces set status='active' where id=$1`,
        [form.workspaceId],
      );
    }
  });
}
