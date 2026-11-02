import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FormUnavailableError } from '../../../../src/triggers/forms/errors.js';
import { admin } from '../../../lifecycle/calls/fixtures.js';
import {
  adminUrl,
  withDatabase,
} from '../../../lifecycle/retention.support.js';
import {
  openTransaction,
  sqlStates,
  waitForWaiter,
} from '../../webhooks/ingress/lock-holder.js';
import {
  newCapability,
  openPublicly,
  PAUSE_STATEMENT,
  response,
  runs,
  type Form,
} from './door-support.js';
import { fixture, store, submitForm } from './fixture.js';

const ADMISSION_LOCK = /lock_workspace_run_admission/iu;
const LINK_LOCK = /for share of "form"/iu;
const WORKFLOW_LOCK = /for share of "workflow"/iu;

export function registerLockOrder(): void {
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
}
