import { randomBytes, randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { ownerQuery, seedWebhook } from '../fixture.js';
import { publishAndReconcile } from '../publish-flow.js';
import {
  comparable,
  deliver,
  holdRows,
  inWorkspace,
  PAUSE,
  rejectedRows,
  send,
  traces,
  type Seeded,
} from './support.js';

const CLOSED_DOORS: readonly (readonly [
  string,
  (seeded: Seeded) => Promise<unknown>,
])[] = [
  [
    'a disabled endpoint',
    ({ workspaceId, workflowId }) =>
      inWorkspace(
        workspaceId,
        "update app.webhook_trigger_endpoints set status='disabled' where workflow_id=$1",
        [workflowId],
      ),
  ],
  [
    'an archived workflow',
    ({ workflowId }) =>
      ownerQuery(
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [workflowId],
      ),
  ],
  [
    'a suspended workspace',
    ({ workspaceId }) =>
      ownerQuery("update app.workspaces set status='suspended' where id=$1", [
        workspaceId,
      ]),
  ],
  [
    'a workspace pending deletion',
    ({ workspaceId, actorId }) =>
      ownerQuery(
        `update app.workspaces set status='pending_deletion',
           deletion_requested_at=clock_timestamp(),deletion_requested_by=$2,
           deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
        [workspaceId, actorId],
      ),
  ],
  [
    'a publish that removed the step',
    (seeded) =>
      publishAndReconcile(seeded, {
        settings: {},
        nodes: [
          {
            id: 'finish',
            definition: { key: 'core.terminate', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
      }),
  ],
];

export function registerClosedDoors(): void {
  it.each(CLOSED_DOORS)(
    'answers %s exactly as an unknown address: 401, no delivery row, no limit spent',
    async (_name, close) => {
      const seeded = await seedWebhook(`closed-${randomUUID()}`);
      expect((await deliver(seeded)).status).toBe(202);
      await close(seeded);
      const before = await traces(seeded);
      expect(before.spent).toBe(1);

      const closed = await deliver(seeded);
      const unknown = await send(randomBytes(32).toString('base64url'), {
        secret: seeded.originalSecret,
      });

      expect(closed.status).toBe(401);
      expect(closed.body).toMatchObject({
        code: 'webhook.authentication_failed',
      });
      expect(comparable(closed)).toEqual(comparable(unknown));
      expect(await traces(seeded)).toEqual(before);
    },
    60_000,
  );

  it('tells a paused workflow only to a sender who proved the signature', async () => {
    const seeded = await seedWebhook(`paused-${randomUUID()}`);
    expect((await deliver(seeded)).status).toBe(202);
    await ownerQuery(PAUSE, [seeded.workflowId]);
    const unsigned = await send(seeded.endpointKey, {});
    const unknown = await send(randomBytes(32).toString('base64url'), {});
    expect(comparable(unsigned)).toEqual(comparable(unknown));

    const before = await traces(seeded);
    const signed = await deliver(seeded);
    expect(signed.status).toBe(423);
    expect(signed.body).toMatchObject({ code: 'webhook.workflow_paused' });
    expect((await traces(seeded)).runs).toBe(before.runs);
  }, 60_000);

  it.each([
    [
      'an archive',
      "update app.workflows set lifecycle_status='archived' where id=$1",
      401,
    ],
    ['a pause', PAUSE, 423],
  ] as const)(
    'refuses a sender waiting on the lock while %s commits, and starts nothing',
    async (_name, statement, status) => {
      const seeded = await seedWebhook(`wait-${randomUUID()}`);
      expect((await deliver(seeded)).status).toBe(202);
      const before = await traces(seeded);
      const holder = await holdRows(seeded.workspaceId);
      try {
        await holder.client.query(statement, [seeded.workflowId]);
        const waiting = deliver(seeded);
        await holder.waitForWaiters(1);
        await holder.finish();
        const answered = await waiting;
        expect(answered.status).toBe(status);
        expect(await traces(seeded)).toEqual({
          ...before,
          // The sender proved itself, so its attempt is on the owner's log (ADR 045).
          rejected: before.rejected + 1,
          spent: before.spent + 1,
        });
        expect(await rejectedRows(seeded)).toMatchObject([
          { http_status: status },
        ]);
      } finally {
        await holder.finish();
      }
    },
    60_000,
  );
}
