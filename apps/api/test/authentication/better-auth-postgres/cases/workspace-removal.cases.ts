import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  adminUrl,
  databaseUrl,
  apiUrl,
  runtime,
  signInVerifiedUser,
} from '../fixture.js';

export function registerRevokesSameBrowserAuthorityOwnedWorkspace(): void {
  it('revokes the same browser authority when an owned workspace becomes unavailable', async () => {
    const { cookie, authenticated } = await signInVerifiedUser(
      'workspace-owner@example.test',
      'Workspace Owner',
    );

    const workspaceId = randomUUID();
    const owner = new Pool({ connectionString: databaseUrl(adminUrl), max: 1 });
    try {
      await owner.query(
        `insert into app.workspaces(id,name,slug,created_by)
         values($1,'Session revocation workspace',$2,$3)`,
        [
          workspaceId,
          `session-revocation-${workspaceId}`,
          authenticated?.userId,
        ],
      );
      await owner.query(
        `insert into app.workspace_memberships(workspace_id,user_id,role,status)
         values($1,$2,'owner','active')`,
        [workspaceId, authenticated?.userId],
      );
      await expect(
        owner.query<{ status: string }>(
          'select status from app.workspaces where id=$1',
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ status: 'active' }] });
      await owner.query(
        `update app.workspaces set status='suspended',updated_at=clock_timestamp()
          where id=$1`,
        [workspaceId],
      );
      const sessions = await owner.query<{
        count: number;
        membership_status: string;
        workspace_status: string;
      }>(
        `select workspace.status workspace_status,
                membership.status membership_status,
                count(session.id)::integer count
           from app.workspaces workspace
           join app.workspace_memberships membership
             on membership.workspace_id=workspace.id
           left join app.auth_sessions session
             on session.user_id=membership.user_id
          where workspace.id=$1 and membership.user_id=$2
          group by workspace.status,membership.status`,
        [workspaceId, authenticated?.userId],
      );
      expect(sessions.rows).toEqual([
        {
          count: 0,
          membership_status: 'active',
          workspace_status: 'suspended',
        },
      ]);
    } finally {
      await owner.end();
    }
    expect(await runtime.sessions.authenticate(cookie ?? '')).toBeUndefined();
  });

  it('keeps identity audit facts out of reach of app deletes', async () => {
    const api = new Pool({ connectionString: apiUrl, max: 1 });
    try {
      await expect(
        api.query('delete from app.identity_security_audit_facts'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });
}
