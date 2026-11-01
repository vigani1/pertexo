import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { isAuthenticationSessionAllowed } from '../../../src/tenant-access/index.js';
import { useIdentityCommandDatabase } from '../command.support.js';

const db = useIdentityCommandDatabase('session_lookup');
async function setup() {
  const owner = await db.user('Owner');
  const workspaceId = await db.workspace(owner.id);
  const organizationId = randomUUID(),
    domainId = randomUUID(),
    providerId = randomUUID();
  const domain = `${randomUUID()}.example.test`;
  await db.asAdmin(
    "insert into app.auth_organizations(id,control_workspace_id,name) values($1,$2,'Organization')",
    [organizationId, workspaceId],
  );
  await db.asAdmin(
    'insert into app.auth_domains(id,organization_id,domain,verified_at,require_sso) values($1,$2,$3,clock_timestamp(),true)',
    [domainId, organizationId, domain],
  );
  await db.asAdmin(
    `insert into app.auth_providers(id,organization_id,kind,name,issuer,configuration,sealed_secret,enabled) values($1,$2,'oidc','Identity','https://example.test','{}','{}',true)`,
    [providerId, organizationId],
  );
  await db.asAdmin(
    'update app.users set email=$2,email_verified=true where id=$1',
    [owner.id, `owner@${domain}`],
  );
  await db.asAdmin(
    `insert into app.auth_accounts(id,user_id,provider_id,account_id,password) values($1,$2::uuid,'credential',$2::text,'hash')`,
    [randomUUID(), owner.id],
  );
  const token = await db.sessions(owner.id);
  const [session] = await db.asAdmin<{ id: string }>(
    'select id from app.auth_sessions where token=$1',
    [token],
  );
  if (!session) throw new Error('Missing session');
  return {
    owner,
    workspaceId,
    organizationId,
    providerId,
    domainId,
    sessionId: session.id,
  };
}

describe('read-only session policy lookup', () => {
  it('uses exactly one statement on a read-only connection and clears workspace scope before reuse', async () => {
    const fixture = await setup();
    const pool = new Pool({
      ...db.authenticationPool().options,
      max: 1,
      options: '-c default_transaction_read_only=on',
    });
    try {
      const client = await pool.connect();
      const query = vi.spyOn(client, 'query');
      client.release();
      try {
        await expect(
          isAuthenticationSessionAllowed(pool, fixture.sessionId),
        ).resolves.toBe(true);
        expect(query).toHaveBeenCalledTimes(1);
      } finally {
        query.mockRestore();
      }
      expect(
        (
          await pool.query(
            "select current_setting('transaction_read_only') read_only, nullif(current_setting('app.workspace_id',true),'') workspace",
          )
        ).rows,
      ).toEqual([{ read_only: 'on', workspace: null }]);
      await expect(
        isAuthenticationSessionAllowed(pool, randomUUID()),
      ).resolves.toBe(false);
      expect(
        (
          await pool.query(
            "select nullif(current_setting('app.workspace_id',true),'') workspace",
          )
        ).rows,
      ).toEqual([{ workspace: null }]);
    } finally {
      await pool.end();
    }
  });
  it('immediately observes recovery eligibility changes without leaking another workspace owner grant', async () => {
    const f = await setup();
    const allowed = () =>
      isAuthenticationSessionAllowed(db.authenticationPool(), f.sessionId);
    expect(await allowed()).toBe(true);
    const duplicate = randomUUID();
    await db.asAdmin(
      "insert into app.auth_accounts(id,user_id,provider_id,account_id,password) values($1::uuid,$2,'credential',$1::text,'hash')",
      [duplicate, f.owner.id],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin('delete from app.auth_accounts where id=$1', [duplicate]);
    expect(await allowed()).toBe(true);
    await db.asAdmin('update app.users set email_verified=false where id=$1', [
      f.owner.id,
    ]);
    expect(await allowed()).toBe(false);
    await db.asAdmin('update app.users set email_verified=true where id=$1', [
      f.owner.id,
    ]);
    await db.asAdmin(
      "update app.auth_accounts set password='' where user_id=$1",
      [f.owner.id],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      "update app.auth_accounts set password='hash' where user_id=$1",
      [f.owner.id],
    );
    await db.workspace(f.owner.id);
    for (const status of ['suspended', 'removed']) {
      await db.asAdmin(
        'update app.workspace_memberships set status=$3 where workspace_id=$1 and user_id=$2',
        [f.workspaceId, f.owner.id, status],
      );
      expect(await allowed()).toBe(false);
    }
    await db.asAdmin(
      "update app.workspace_memberships set status='active',role='admin' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, f.owner.id],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
      [f.workspaceId, f.owner.id],
    );
    expect(await allowed()).toBe(true);
    await db.asAdmin(
      "update app.auth_sessions set authentication_method='social' where id=$1",
      [f.sessionId],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      'update app.auth_domains set require_sso=false where id=$1',
      [f.domainId],
    );
    expect(await allowed()).toBe(true);
  });
  it('observes provider, directory, account and session revocation in the same policy', async () => {
    const f = await setup();
    await db.asAdmin(
      "update app.auth_sessions set authentication_method='organization',federation_provider_id=$2,federation_provider_revision=1 where id=$1",
      [f.sessionId, f.providerId],
    );
    const allowed = () =>
      isAuthenticationSessionAllowed(db.authenticationPool(), f.sessionId);
    expect(await allowed()).toBe(true);
    await db.asAdmin('update app.auth_providers set revision=2 where id=$1', [
      f.providerId,
    ]);
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      'update app.auth_providers set revision=1,enabled=false where id=$1',
      [f.providerId],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin('update app.auth_providers set enabled=true where id=$1', [
      f.providerId,
    ]);
    const directoryId = randomUUID();
    await db.asAdmin(
      `insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,profile,user_id) values($1,$2,'member','member','member@example.test','{}',$3)`,
      [directoryId, f.organizationId, f.owner.id],
    );
    expect(await allowed()).toBe(true);
    await db.asAdmin(
      'update app.auth_directory_users set active=false where id=$1',
      [directoryId],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      'update app.auth_directory_users set deleted_at=clock_timestamp() where id=$1',
      [directoryId],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      `insert into app.auth_directory_users(id,organization_id,user_name,normalized_user_name,login_email,profile,user_id) values($1,$2,'member','member','member@example.test','{}',$3)`,
      [randomUUID(), f.organizationId, f.owner.id],
    );
    expect(await allowed()).toBe(true);
    await db.asAdmin(
      'update app.auth_domains set verified_at=null where id=$1',
      [f.domainId],
    );
    expect(await allowed()).toBe(false);
    await db.asAdmin(
      'update app.auth_domains set verified_at=clock_timestamp() where id=$1',
      [f.domainId],
    );
    await db.asAdmin("update app.users set status='suspended' where id=$1", [
      f.owner.id,
    ]);
    expect(await allowed()).toBe(false);
    await db.asAdmin("update app.users set status='active' where id=$1", [
      f.owner.id,
    ]);
    await db.asAdmin(
      "update app.auth_sessions set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [f.sessionId],
    );
    expect(await allowed()).toBe(false);
  });
});
