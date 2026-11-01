import { randomBytes, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { FormValuesInvalidError } from '@pertexo/workflow-model';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { store, submitForm, fixture } from './fixture.js';

export function registerAdmitsTypedMultipleChoicesOnce(): void {
  it('admits typed multiple choices once and refuses malformed choices before admission', async () => {
    const f = await fixture({
      fields: [
        {
          id: 'channels',
          name: 'channels',
          label: 'Channels',
          type: 'multi_select',
          options: ['Email', 'SMS'],
        },
      ],
    });
    const command = {
      ...f,
      versionId: f.versionId,
      idempotencyKey: 'choices',
      values: { channels: ['SMS', 'Email'] },
    };
    const accepted = await submitForm(command);
    expect(accepted.thankYouMessage).toBe('Thanks for your response.');
    expect(
      (
        await admin.query(
          'select input_ref from app.workflow_runs where id=$1',
          [accepted.runId],
        )
      ).rows[0],
    ).toMatchObject({ input_ref: { value: { values: command.values } } });
    for (const channels of [[], ['Email', 'Email'], ['Other'], 'Email'])
      await expect(
        submitForm({
          ...command,
          idempotencyKey: randomUUID(),
          values: { channels },
        }),
      ).rejects.toBeInstanceOf(FormValuesInvalidError);
    expect(
      (
        await admin.query(
          'select count(*)::int n from app.workflow_runs where workflow_id=$1',
          [f.workflowId],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it.each(['member', 'public'] as const)(
    'records an idempotent %s busy receipt, without a run, and accepts a fresh response after release',
    async (accessKind) => {
      const f = await fixture();
      let grant;
      if (accessKind === 'public') {
        const capability = randomBytes(32).toString('base64url');
        const access = await store.setAccess({
          ...f,
          access: 'public',
          expectedRevision: 0,
          capability,
          idempotencyKey: 'skip-public-access',
        });
        if (access.publicId === null) throw new Error('Public form missing');
        grant = await store.discover({ publicId: access.publicId, capability });
      }
      await admin.query(
        `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
        [f.workspaceId, f.workflowId],
      );
      const command = {
        workspaceId: f.workspaceId,
        workflowId: f.workflowId,
        versionId: f.versionId,
        ...(grant === undefined ? { actorId: f.viewerId } : {}),
        values: { amount: 20 },
        idempotencyKey: 'skip-first',
      };
      const first = await store.submit(command, grant);
      expect(first.accepted).toBe(true);
      const busy = { ...command, idempotencyKey: 'skip-busy' };
      expect(await store.submit(busy, grant)).toEqual({
        accepted: false,
        skipped: true,
        reason: 'concurrency_limit',
        replayed: false,
      });
      expect(await store.submit(busy, grant)).toEqual({
        accepted: false,
        skipped: true,
        reason: 'concurrency_limit',
        replayed: true,
      });
      const count = () =>
        admin.query(
          `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,(select count(*)::int from app.usage_events where resource_id=$1 and category='trigger.skipped') skips,(select count(*)::int from app.idempotency_records where workspace_id=$2 and status='in_progress') incomplete`,
          [f.workflowId, f.workspaceId],
        );
      expect((await count()).rows).toEqual([
        { runs: 1, skips: 1, incomplete: 0 },
      ]);
      await admin.query(
        `update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where workflow_id=$1 and status='queued'`,
        [f.workflowId],
      );
      expect((await store.submit(busy, grant)).accepted).toBe(false);
      expect(
        (await store.submit({ ...command, idempotencyKey: 'skip-next' }, grant))
          .accepted,
      ).toBe(true);
      expect((await count()).rows).toEqual([
        { runs: 2, skips: 1, incomplete: 0 },
      ]);
    },
  );
}
