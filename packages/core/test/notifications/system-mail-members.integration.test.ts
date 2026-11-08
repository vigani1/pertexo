import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { FailureNotificationDestinationConfigSchema } from '@pertexo/workflow-model';
import { expect, it } from 'vitest';
import { createNotificationDestinationStore } from '../../src/notifications/destinations/notification-destination.store.js';
import { useIdentityCommandDatabase } from '../identity/command.support.js';

const db = useIdentityCommandDatabase('sysmail');
async function setup() {
  const owner = await db.user('Mail owner');
  const workspaceId = await db.workspace(owner.id);
  const member = await db.user('Alert recipient');
  await db.member(workspaceId, member.id, 'viewer');
  const connectionString = db.authenticationPool().options.connectionString;
  if (typeof connectionString !== 'string')
    throw new Error('No fixture database');
  return {
    owner,
    workspaceId,
    member,
    store: createNotificationDestinationStore(
      parseDatabaseConfig({ connectionString, max: 2 }),
    ),
  };
}
const command = () => ({
  idempotencyKey: randomUUID(),
  requestHash: 'a'.repeat(64),
  destinationId: randomUUID(),
});
const config = (memberId: string) =>
  FailureNotificationDestinationConfigSchema.parse({
    kind: 'system_mail',
    memberId,
  });
it('saves a member-only destination without creating any email connection', async () => {
  const f = await setup();
  try {
    const result = await f.store.create({
      workspaceId: f.workspaceId,
      actorId: f.owner.id,
      ...command(),
      config: config(f.member.id),
    });
    expect(result.config).toEqual({
      kind: 'system_mail',
      memberId: f.member.id,
    });
    expect(
      (
        await f.store.list({ workspaceId: f.workspaceId, actorId: f.owner.id })
      )[0]?.config,
    ).toEqual(result.config);
  } finally {
    await f.store.close();
  }
});
it('refuses a person outside the workspace and a removed member', async () => {
  const f = await setup();
  try {
    const outsider = await db.user('Other account');
    for (const memberId of [outsider.id, f.member.id]) {
      if (memberId === f.member.id)
        await db.asAdmin(
          "update app.workspace_memberships set status='removed' where workspace_id=$1 and user_id=$2",
          [f.workspaceId, memberId],
        );
      await expect(
        f.store.create({
          workspaceId: f.workspaceId,
          actorId: f.owner.id,
          ...command(),
          config: config(memberId),
        }),
      ).rejects.toMatchObject({ code: 'recipient_unavailable' });
    }
  } finally {
    await f.store.close();
  }
});
