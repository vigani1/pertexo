import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { purgeWorkspace } from '../../support/workspace-purge.js';
import { adminUrl, maintenanceUrl, createWorkspace } from './fixture.js';

export function registerRemovesDirectoryManagedGrantsOther(): void {
  it('removes directory-managed grants in other linked workspaces before deleting the control organization', async () => {
    const control = await createWorkspace(),
      linked = await createWorkspace();
    const inspector = new Pool({ connectionString: adminUrl, max: 1 });
    const organizationId = randomUUID(),
      directoryId = randomUUID(),
      managedId = randomUUID(),
      manualId = randomUUID();
    try {
      await inspector.query(
        "insert into app.users(id,email,email_verified,display_name,status) values($1,$1::uuid::text||'@purge.test',true,'Managed','active'),($2,$2::uuid::text||'@purge.test',true,'Manual','active')",
        [managedId, manualId],
      );
      await inspector.query(
        "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Directory purge')",
        [organizationId, control],
      );
      await inspector.query(
        'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$3),($2,$3)',
        [control, linked, organizationId],
      );
      await inspector.query(
        `insert into app.auth_directory_users(id,organization_id,user_id,user_name,normalized_user_name,login_email,profile)
        values($1,$2,$3,'managed','managed',$3::uuid::text||'@purge.test','{"emails":[{"value":"managed@purge.test","primary":true}]}')`,
        [directoryId, organizationId, managedId],
      );
      await inspector.query(
        "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$3,'builder','active'),($2,$3,'builder','active'),($2,$4,'operator','active')",
        [control, linked, managedId, manualId],
      );
      await inspector.query(
        'insert into app.auth_directory_memberships(organization_id,workspace_id,user_id,directory_user_id) values($1,$2,$4,$5),($1,$3,$4,$5)',
        [organizationId, control, linked, managedId, directoryId],
      );
      await inspector.query(
        "insert into app.auth_sessions(id,user_id,token,expires_at) values($1,$2,$1::uuid::text,clock_timestamp()+interval '1 hour')",
        [randomUUID(), managedId],
      );
      await inspector.query(
        "insert into app.notice_preferences(workspace_id,user_id,mode) values($1,$2,'immediate')",
        [linked, managedId],
      );
      await purgeWorkspace({
        adminUrl,
        maintenanceUrl,
        workspaceId: control,
        pageSize: 1,
      });
      expect(
        (
          await inspector.query(
            'select role,status,role_revision from app.workspace_memberships where workspace_id=$1 and user_id=$2',
            [linked, managedId],
          )
        ).rows,
      ).toEqual([{ role: 'builder', status: 'removed', role_revision: 2 }]);
      expect(
        (
          await inspector.query(
            'select role,status from app.workspace_memberships where workspace_id=$1 and user_id=$2',
            [linked, manualId],
          )
        ).rows,
      ).toEqual([{ role: 'operator', status: 'active' }]);
      expect(
        (
          await inspector.query(
            'select id from app.auth_organizations where id=$1',
            [organizationId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inspector.query(
            'select user_id from app.auth_directory_memberships where organization_id=$1',
            [organizationId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inspector.query(
            'select id from app.auth_sessions where user_id=$1',
            [managedId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await inspector.query(
            'select user_id from app.notice_preferences where workspace_id=$1 and user_id=$2',
            [linked, managedId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await inspector.end();
    }
  });

  it.each(['oidc', 'saml'] as const)(
    'purges %s organization identities in bounded pages without removing ordinary credentials or another workspace',
    async (kind) => {
      const workspaceId = await createWorkspace(),
        otherWorkspaceId = await createWorkspace();
      const inspector = new Pool({ connectionString: adminUrl, max: 1 });
      const organizationId = randomUUID(),
        providerId = randomUUID(),
        accountId = randomUUID();
      try {
        const user = (
          await inspector.query<{ created_by: string }>(
            'select created_by from app.workspaces where id=$1',
            [workspaceId],
          )
        ).rows[0];
        if (user === undefined) throw new Error('Purge user missing');
        await inspector.query(
          "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Purge organization')",
          [organizationId, workspaceId],
        );
        await inspector.query(
          'insert into app.auth_organization_workspaces(workspace_id,organization_id) values($1,$3),($2,$3)',
          [workspaceId, otherWorkspaceId, organizationId],
        );
        await inspector.query(
          "insert into app.auth_providers(id,organization_id,kind,name,issuer,configuration,sealed_secret,enabled) values($1,$2,$3,'Purge provider','https://idp.example.test','{}',case when $3='oidc' then '{}'::jsonb else null end,true)",
          [providerId, organizationId, kind],
        );
        await inspector.query(
          "insert into app.auth_accounts(id,user_id,provider_id,account_id,password) values($1,$2::uuid,'credential',$2::text,'kept-password-hash'),($3,$2::uuid,$4,'provider-subject',null)",
          [accountId, user.created_by, randomUUID(), providerId],
        );
        await inspector.query(
          "insert into app.auth_sessions(id,user_id,token,expires_at,authentication_method,federation_provider_id,federation_provider_revision) values($1,$2,$3,clock_timestamp()+interval '1 hour','organization',$4,1)",
          [randomUUID(), user.created_by, randomUUID(), providerId],
        );
        const maintenance = new Pool({
          connectionString: maintenanceUrl,
          max: 1,
        });
        try {
          expect(
            (
              await maintenance.query(
                'select id,provider_id from app.auth_accounts where id=$1',
                [accountId],
              )
            ).rowCount,
          ).toBe(1);
          await expect(
            maintenance.query(
              'select password from app.auth_accounts where id=$1',
              [accountId],
            ),
          ).rejects.toHaveProperty('code', '42501');
        } finally {
          await maintenance.end();
        }
        await purgeWorkspace({
          adminUrl,
          maintenanceUrl,
          workspaceId,
          pageSize: 1,
        });
        expect(
          (
            await inspector.query(
              'select id from app.auth_organizations where id=$1',
              [organizationId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await inspector.query(
              'select id from app.auth_sessions where federation_provider_id=$1',
              [providerId],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await inspector.query(
              'select provider_id from app.auth_accounts where user_id=$1',
              [user.created_by],
            )
          ).rows,
        ).toEqual([{ provider_id: 'credential' }]);
        expect(
          (
            await inspector.query(
              'select status from app.workspaces where id=$1',
              [otherWorkspaceId],
            )
          ).rows,
        ).toEqual([{ status: 'active' }]);
      } finally {
        await inspector.end();
      }
    },
  );
}
