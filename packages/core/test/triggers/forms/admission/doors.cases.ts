import { randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkflowFolderDatabase } from '../../../../src/authoring/organization/folders/commands.repository.js';
import { FormUnavailableError } from '../../../../src/triggers/forms/errors.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { admin } from '../../../lifecycle/calls/fixtures.js';
import {
  adminUrl,
  apiUrl,
  withDatabase,
} from '../../../lifecycle/retention.support.js';
import {
  openTransaction,
  sqlStates,
  waitForWaiter,
} from '../../webhooks/ingress/lock-holder.js';
import { fixture, store, submitForm } from './fixture.js';

type Form = Awaited<ReturnType<typeof fixture>>;

const ADMISSION_LOCK = /lock_workspace_run_admission/iu;
const LINK_LOCK = /for share of "form"/iu;
const WORKFLOW_LOCK = /for share of "workflow"/iu;

const newCapability = () => randomBytes(32).toString('base64url');

async function openPublicly(f: Form) {
  const capability = newCapability();
  const access = await store.setAccess({
    ...f,
    access: 'public',
    expectedRevision: 0,
    capability,
    idempotencyKey: `enable-${capability}`,
  });
  if (access.publicId === null) throw new Error('Public identity missing');
  const grant = await store.discover({ publicId: access.publicId, capability });
  return { capability, grant, publicId: access.publicId, access };
}

const runs = async ({ workflowId }: Form) =>
  (
    await admin.query<{ count: number }>(
      'select count(*)::int count from app.workflow_runs where workflow_id=$1',
      [workflowId],
    )
  ).rows[0]?.count;

const response = (f: Form, idempotencyKey = randomUUID()) => ({
  workspaceId: f.workspaceId,
  workflowId: f.workflowId,
  versionId: f.versionId,
  values: { amount: 1 },
  idempotencyKey,
});

const closeWorkspace = {
  suspended: ({ workspaceId }: Form) =>
    admin.query("update app.workspaces set status='suspended' where id=$1", [
      workspaceId,
    ]),
  pending_deletion: ({ workspaceId, actorId }: Form) =>
    admin.query(
      `update app.workspaces set status='pending_deletion',deletion_requested_at=clock_timestamp(),
         deletion_requested_by=$2,deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
       where id=$1`,
      [workspaceId, actorId],
    ),
};

/** A pause has to name the run behind it, so this leaves one more run than it found. */
const PAUSE_STATEMENT = `update app.workflows
    set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
        trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
        trigger_pause_last_run_id=(select id from app.workflow_runs where workflow_id=$1 limit 1),
        trigger_pause_revision=trigger_pause_revision+1
  where id=$1`;

async function addMember(f: Form, role: string) {
  const id = randomUUID();
  await admin.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Form member')`,
    [id, `${id}@example.test`],
  );
  await admin.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
    [f.workspaceId, id, role],
  );
  return id;
}

export function registerDoors(): void {
  let holders: Pool;
  const hold = (workspaceId: string) =>
    openTransaction(holders, holders, workspaceId, { role: undefined });

  beforeAll(() => {
    holders = new Pool({
      connectionString: withDatabase(adminUrl),
      max: 4,
    });
  });
  afterAll(() => holders.end());

  describe('a form submission’s lock order', () => {
    const holdEntitlement = async (f: Form) => {
      const holder = await hold(f.workspaceId);
      await holder.query(
        'select 1 from app.workspace_execution_entitlements where workspace_id=$1 for update',
        [f.workspaceId],
      );
      return holder;
    };

    it('checks a member’s authority after the admission lock, so a removal during the wait refuses', async () => {
      const f = await fixture();
      const holder = await holdEntitlement(f);
      try {
        const waiting = submitForm({
          ...response(f),
          actorId: f.viewerId,
        });
        const refusal =
          expect(waiting).rejects.toBeInstanceOf(FormUnavailableError);
        await waitForWaiter(holder, ADMISSION_LOCK);
        // It holds no lock on the membership yet, so this doesn't have to wait for it.
        await admin.query(
          "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
          [f.workspaceId, f.viewerId],
        );
        await holder.commit();
        await refusal;
        expect(await runs(f)).toBe(0);
      } finally {
        await holder.rollback();
      }
    }, 30_000);

    it('checks a public link after the admission lock, so a regeneration during the wait refuses', async () => {
      const f = await fixture();
      const { grant, access } = await openPublicly(f);
      const holder = await holdEntitlement(f);
      try {
        const waiting = submitForm(response(f), grant);
        const refusal =
          expect(waiting).rejects.toBeInstanceOf(FormUnavailableError);
        await waitForWaiter(holder, ADMISSION_LOCK);
        await store.setAccess({
          ...f,
          access: 'public',
          expectedRevision: access.revision,
          capability: newCapability(),
          idempotencyKey: randomUUID(),
        });
        await holder.commit();
        await refusal;
        expect(await runs(f)).toBe(0);
      } finally {
        await holder.rollback();
      }
    }, 30_000);

    it.each([
      ['commits', true],
      ['rolls back', false],
    ] as const)(
      'orders a response against a link regeneration that %s while it waits on the form row',
      async (_name, commits) => {
        const f = await fixture();
        const { grant } = await openPublicly(f);
        const holder = await hold(f.workspaceId);
        try {
          await holder.query(
            `update app.workflow_forms set capability_hash=$2,revision=revision+1
              where workflow_id=$1`,
            [f.workflowId, 'f'.repeat(64)],
          );
          const waiting = submitForm(response(f), grant);
          const settled = waiting.then(
            () => 'accepted',
            (error: unknown) => error,
          );
          await waitForWaiter(holder, LINK_LOCK);
          if (commits) {
            await holder.commit();
            expect(await settled).toBeInstanceOf(FormUnavailableError);
            expect(await runs(f)).toBe(0);
          } else {
            await holder.rollback();
            expect(await settled).toBe('accepted');
            expect(await runs(f)).toBe(1);
          }
        } finally {
          await holder.rollback();
        }
      },
      30_000,
    );

    it.each([
      [
        'an archive',
        "update app.workflows set lifecycle_status='archived' where id=$1",
      ],
      ['a pause', PAUSE_STATEMENT],
    ])(
      'refuses a response waiting on the workflow row while %s commits',
      async (_name, statement) => {
        const f = await fixture();
        const { grant } = await openPublicly(f);
        await submitForm(response(f), grant);
        const before = await runs(f);
        const holder = await hold(f.workspaceId);
        try {
          await holder.query(statement, [f.workflowId]);
          const refusal = expect(
            submitForm(response(f), grant),
          ).rejects.toBeInstanceOf(FormUnavailableError);
          await waitForWaiter(holder, WORKFLOW_LOCK);
          await holder.commit();
          await refusal;
          expect(await runs(f)).toBe(before);
        } finally {
          await holder.rollback();
        }
      },
      30_000,
    );

    it('never deadlocks with link changes, and a response is accepted or refused by name', async () => {
      const f = await fixture();
      const opened = await openPublicly(f);
      let revision = opened.access.revision;
      for (let round = 0; round < 8; round += 1) {
        const outcomes = await Promise.allSettled([
          submitForm(response(f), opened.grant),
          store.setAccess({
            ...f,
            access: 'public',
            expectedRevision: revision,
            capability: opened.capability,
            idempotencyKey: randomUUID(),
          }),
          submitForm(response(f), opened.grant),
        ]);
        const change = outcomes[1];
        if (change.status === 'fulfilled') ({ revision } = change.value);
        expect(
          outcomes.flatMap((outcome) =>
            outcome.status === 'rejected' ? sqlStates(outcome.reason) : [],
          ),
        ).not.toContain('40P01');
      }
    }, 60_000);
  });

  describe('a public link', () => {
    it('refuses every wrong capability in the same words', async () => {
      const f = await fixture();
      const other = await fixture();
      const { capability, publicId, access } = await openPublicly(f);
      const others = await openPublicly(other);
      await store.setAccess({
        ...f,
        access: 'public',
        expectedRevision: access.revision,
        capability: newCapability(),
        idempotencyKey: randomUUID(),
      });
      const attempts = [
        { publicId, capability: newCapability() },
        { publicId, capability },
        { publicId, capability: others.capability },
        { publicId: randomUUID(), capability: others.capability },
        { publicId: randomUUID(), capability: newCapability() },
      ];
      const refusals = await Promise.all(
        attempts.map((attempt) =>
          store.discover(attempt).then(
            () => {
              throw new Error('A wrong capability opened a form');
            },
            (error: unknown) => error,
          ),
        ),
      );
      for (const refusal of refusals)
        expect(refusal).toBeInstanceOf(FormUnavailableError);
      expect(
        new Set(refusals.map((refusal) => (refusal as Error).message)).size,
      ).toBe(1);
    });

    it('gives another form’s grant nothing here, for reading or submitting', async () => {
      const f = await fixture();
      const other = await fixture();
      await openPublicly(f);
      const { grant: otherGrant } = await openPublicly(other);
      await expect(
        store.read(
          { workspaceId: f.workspaceId, workflowId: f.workflowId },
          otherGrant,
        ),
      ).rejects.toBeInstanceOf(FormUnavailableError);
      await expect(submitForm(response(f), otherGrant)).rejects.toBeInstanceOf(
        FormUnavailableError,
      );
      // The other form's identity with this workflow named on it isn't this form's link.
      await expect(
        submitForm(response(f), {
          ...otherGrant,
          workspaceId: f.workspaceId,
          workflowId: f.workflowId,
        }),
      ).rejects.toBeInstanceOf(FormUnavailableError);
      expect(await runs(f)).toBe(0);
    });

    it('refuses a grant naming another step of the same form', async () => {
      const f = await fixture();
      const { grant } = await openPublicly(f);
      await expect(
        submitForm(response(f), { ...grant, nodeId: 'finish' }),
      ).rejects.toBeInstanceOf(FormUnavailableError);
      expect(await runs(f)).toBe(0);
    });

    it.each([
      ['a suspended workspace', closeWorkspace.suspended],
      ['a workspace pending deletion', closeWorkspace.pending_deletion],
      [
        'a paused workflow',
        ({ workflowId }: Form) => admin.query(PAUSE_STATEMENT, [workflowId]),
      ],
      [
        'an archived workflow',
        ({ workflowId }: Form) =>
          admin.query(
            "update app.workflows set lifecycle_status='archived' where id=$1",
            [workflowId],
          ),
      ],
    ])(
      'reads and takes nothing on %s, and reveals which by nothing',
      async (_name, close) => {
        const f = await fixture();
        const { grant } = await openPublicly(f);
        await submitForm(response(f), grant);
        const before = await runs(f);
        const scope = { workspaceId: f.workspaceId, workflowId: f.workflowId };
        const wrong = await store
          .read(scope, { ...grant, capabilityHash: 'e'.repeat(64) })
          .catch((error: unknown) => error);
        await close(f);
        const read = await store
          .read(scope, grant)
          .catch((error: unknown) => error);
        expect(read).toBeInstanceOf(FormUnavailableError);
        expect((read as Error).message).toBe((wrong as Error).message);
        await expect(submitForm(response(f), grant)).rejects.toBeInstanceOf(
          FormUnavailableError,
        );
        expect(await runs(f)).toBe(before);
      },
    );

    it('starts one run for an exact retry racing itself, and conflicts on different values', async () => {
      const f = await fixture();
      const { grant } = await openPublicly(f);
      const command = response(f, 'public-retry');
      const answers = await Promise.all(
        Array.from({ length: 4 }, () => submitForm(command, grant)),
      );
      expect(answers.filter(({ replayed }) => replayed)).toHaveLength(3);
      for (const answer of answers) expect(answer).not.toHaveProperty('runId');
      expect(await runs(f)).toBe(1);
      await expect(
        submitForm({ ...command, values: { amount: 2 } }, grant),
      ).rejects.toThrow(/idempotency/iu);
      expect(await runs(f)).toBe(1);
    });
  });

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
        await admin.query(
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
