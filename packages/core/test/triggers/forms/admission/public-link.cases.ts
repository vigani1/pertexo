import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FormUnavailableError } from '../../../../src/triggers/forms/errors.js';
import { admin } from '../../../lifecycle/calls/fixtures.js';
import {
  closeWorkspace,
  newCapability,
  openPublicly,
  PAUSE_STATEMENT,
  response,
  runs,
  type Form,
} from './door-support.js';
import { fixture, store, submitForm } from './fixture.js';

export function registerPublicLink(): void {
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
}
