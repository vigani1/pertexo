import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createWorkflowFolderDatabase } from '../../../../src/authoring/organization/folders/commands.repository.js';
import { FormUnavailableError } from '../../../../src/triggers/forms/errors.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { admin } from '../../../lifecycle/calls/fixtures.js';
import { apiUrl } from '../../../lifecycle/retention.support.js';
import {
  addMember,
  closeWorkspace,
  newCapability,
  response,
  runs,
  type Form,
} from './door-support.js';
import { fixture, store, submitForm } from './fixture.js';

export function registerMemberAccess(): void {
  describe('members and a form', () => {
    const EDITORS = ['admin', 'builder'] as const;
    const NOT_EDITORS = ['operator', 'viewer'] as const;
    const history = (f: Form, actorId: string) =>
      store.history({ ...f, actorId, limit: 10 });
    const access = (f: Form, actorId: string) =>
      store.access({ ...f, actorId });
    const change = (f: Form, actorId: string, expectedRevision: number) =>
      store.setAccess({
        ...f,
        actorId,
        access: 'public',
        expectedRevision,
        capability: newCapability(),
        idempotencyKey: randomUUID(),
      });
    const accessRow = async ({ workflowId }: Form) =>
      (
        await admin.query<Record<string, unknown>>(
          'select access,revision,capability_hash from app.workflow_forms where workflow_id=$1',
          [workflowId],
        )
      ).rows;
    /** A form with one held event, so its history shows something to be refused. */
    const heldEvent = async () => {
      const f = await fixture({
        coordination: {
          mode: 'debounce',
          key: { kind: 'run_input', path: '$.values.message' },
          quietSeconds: 300,
        },
      });
      await expect(
        store.submit({
          ...response(f),
          actorId: f.actorId,
          values: { amount: 1, message: 'held' },
        }),
      ).resolves.toMatchObject({ accepted: false, status: 'pending' });
      return f;
    };

    it.each([...EDITORS, ...NOT_EDITORS])(
      'lets %s read and submit',
      async (role) => {
        const f = await fixture();
        const member = await addMember(f, role);
        await expect(
          store.read({ ...f, actorId: member }),
        ).resolves.toMatchObject({ versionId: f.versionId });
        await expect(
          submitForm({ ...response(f), actorId: member }),
        ).resolves.toMatchObject({ accepted: true });
        expect(await runs(f)).toBe(1);
      },
    );

    it.each(EDITORS)('lets %s manage access', async (role) => {
      const f = await heldEvent();
      const member = await addMember(f, role);
      await expect(access(f, member)).resolves.toMatchObject({
        access: 'members',
      });
      expect((await history(f, member)).items).toHaveLength(1);
      await expect(change(f, member, 0)).resolves.toMatchObject({
        access: 'public',
        revision: 1,
      });
    });

    it.each(NOT_EDITORS)(
      'keeps %s out of access and history, and writes nothing',
      async (role) => {
        const f = await heldEvent();
        const member = await addMember(f, role);
        const before = await accessRow(f);
        await expect(access(f, member)).rejects.toBeInstanceOf(
          FormUnavailableError,
        );
        await expect(history(f, member)).resolves.toEqual({
          items: [],
          next: null,
        });
        await expect(change(f, member, 0)).rejects.toBeInstanceOf(
          FormUnavailableError,
        );
        expect(await accessRow(f)).toEqual(before);
      },
    );

    it('still shows a suspended workspace’s form, access and history, and changes and takes nothing', async () => {
      const f = await heldEvent();
      await closeWorkspace.suspended(f);
      await expect(store.read(f)).resolves.toMatchObject({
        versionId: f.versionId,
      });
      await expect(access(f, f.actorId)).resolves.toMatchObject({
        access: 'members',
      });
      expect((await history(f, f.actorId)).items).toHaveLength(1);
      const before = await runs(f);
      await expect(
        submitForm({ ...response(f), actorId: f.actorId }),
      ).rejects.toBeInstanceOf(FormUnavailableError);
      await expect(change(f, f.actorId, 0)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      expect(await runs(f)).toBe(before);
    });

    it('shows nothing once deletion is pending', async () => {
      const f = await heldEvent();
      await closeWorkspace.pending_deletion(f);
      await expect(store.read(f)).rejects.toBeInstanceOf(FormUnavailableError);
      await expect(access(f, f.actorId)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      await expect(history(f, f.actorId)).resolves.toEqual({
        items: [],
        next: null,
      });
      await expect(change(f, f.actorId, 0)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
    });

    it('limits a builder in a restricted folder to what the grant allows', async () => {
      const folders = createWorkflowFolderDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      );
      try {
        const f = await fixture();
        const builder = await addMember(f, 'builder');
        const { folder } = await folders.createFolder({
          workspaceId: f.workspaceId,
          actorId: f.actorId,
          name: 'Private',
          parentId: null,
          idempotencyKey: randomUUID(),
        });
        await folders.placeWorkflow({
          workspaceId: f.workspaceId,
          actorId: f.actorId,
          workflowId: f.workflowId,
          folderId: folder.id,
          expectedOrganizationRevision: 1,
          idempotencyKey: randomUUID(),
        });
        await admin.query(
          "update app.workflow_folders set access_mode='restricted' where id=$1",
          [folder.id],
        );
        await expect(
          store.read({ ...f, actorId: builder }),
        ).rejects.toBeInstanceOf(FormUnavailableError);
        await expect(access(f, builder)).rejects.toBeInstanceOf(
          FormUnavailableError,
        );
        await admin.query(
          "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
          [randomUUID(), f.workspaceId, folder.id, builder],
        );
        await expect(
          store.read({ ...f, actorId: builder }),
        ).resolves.toMatchObject({ versionId: f.versionId });
        await expect(access(f, builder)).resolves.toMatchObject({
          access: 'members',
        });
        await expect(change(f, builder, 0)).rejects.toBeInstanceOf(
          FormUnavailableError,
        );
      } finally {
        await folders.close();
      }
    });
  });
}
