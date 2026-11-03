import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { createIdentityWorkspaceStore } from '../../../src/tenant-access/identity-workspace.store.js';
import {
  admin,
  appDatabaseUrl,
  closeWorld,
  identities,
  invitation,
  openWorld,
  team,
} from './world.js';

beforeAll(openWorld);
afterAll(closeWorld);

it.each(['Europe/Belgrade', 'America/New_York'])(
  'pages invitations exactly once in %s with equal and submillisecond creation times',
  async (timezone) => {
    const world = await team();
    const ids: string[] = [];
    for (const micros of ['123456', '123456', '123455', '123454']) {
      const created = await identities.createWorkspaceInvitation(
        invitation(world.workspaceId, world.owner),
      );
      ids.push(created.invitation.id);
      await admin.query(
        "update app.workspace_invitations set created_at=('2026-10-01T12:00:00.' || $2 || 'Z')::timestamptz where id=$1",
        [created.invitation.id, micros],
      );
    }
    const url = new URL(appDatabaseUrl);
    url.searchParams.set('options', `-c timezone=${timezone}`);
    const reader = createIdentityWorkspaceStore(
      parseDatabaseConfig({ connectionString: url.toString(), max: 1 }),
    );
    try {
      const expected = (
        await admin.query<{ id: string }>(
          'select id from app.workspace_invitations where workspace_id=$1 order by created_at desc,id desc',
          [world.workspaceId],
        )
      ).rows.map((row) => row.id);
      const seen: string[] = [];
      let after: { createdAt: string; invitationId: string } | undefined;
      for (let page = 0; page < ids.length; page += 1) {
        const result = await reader.listWorkspaceInvitations(
          world.workspaceId,
          world.owner,
          { limit: 1, ...(after === undefined ? {} : { after }) },
        );
        seen.push(...result.items.map((row) => row.id));
        after = result.nextCursor;
        if (page < ids.length - 1)
          expect(after?.createdAt).toMatch(
            /^2026-10-01T12:00:00\.12345[456]Z$/u,
          );
      }
      expect(after).toBeUndefined();
      expect(seen).toEqual(expected);
    } finally {
      await reader.close();
    }
  },
);
