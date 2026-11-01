import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authenticateDirectory,
  withDirectoryTransaction,
} from '../../../../src/identity/federation/provisioning/authority.repository.js';
import type { DirectoryUserValues } from '../../../../src/identity/federation/provisioning/contract.js';
import { DirectoryError } from '../../../../src/identity/federation/provisioning/errors.js';
import { unlinkDirectoryWorkspace } from '../../../../src/identity/federation/provisioning/management/unlink.repository.js';
import { projectDirectoryMemberships } from '../../../../src/identity/federation/provisioning/projection.repository.js';
import { createDirectoryUser } from '../../../../src/identity/federation/provisioning/resources/users.repository.js';
import { useIdentityCommandDatabase } from '../../command.support.js';

const db = useIdentityCommandDatabase('scim_live_limit');
const person = (): DirectoryUserValues => {
  const email = `${randomUUID()}@example.test`;
  return {
    userName: email,
    active: true,
    externalId: null,
    profile: { emails: [{ value: email, primary: true }] },
  };
};

async function setup() {
  const owner = await db.user('Directory owner'),
    workspaceId = await db.workspace(owner.id),
    scope = { workspaceId, actorId: owner.id };
  const settings = await db.federation().createOrganization({
    ...scope,
    name: 'Directory',
    idempotencyKey: randomUUID(),
  });
  if (settings.organization === null)
    throw new Error('Missing directory organization');
  const organizationId = settings.organization.id,
    digest = randomUUID().replaceAll('-', '').repeat(2);
  await db.asAdmin(
    'insert into app.auth_provisioning_credentials(id,organization_id,name,secret_digest,created_by) values($1,$2,$3,$4,$5)',
    [randomUUID(), organizationId, 'Fixture', digest, owner.id],
  );
  const pool = db.authenticationPool();
  const principal = await authenticateDirectory(pool, organizationId, digest);
  return { owner, scope, organizationId, pool, principal };
}

/** Rows written directly: the limit is what's being tested, so the API can't fill it. */
async function fill(
  organizationId: string,
  count: number,
  { deleted, bound }: Readonly<{ deleted: boolean; bound: boolean }>,
) {
  const ids = Array.from({ length: count }, () => randomUUID());
  if (bound)
    await db.asAdmin(
      `insert into app.users(id,email,email_verified,display_name,status)
      select id,id::text||'@limit.test',true,'Person','active' from unnest($1::uuid[]) id`,
      [ids],
    );
  await db.asAdmin(
    `insert into app.auth_directory_users(id,organization_id,user_id,user_name,normalized_user_name,login_email,profile,deleted_at,active)
    select gen_random_uuid(),$1,case when $3 then id end,id::text,id::text,id::text||'@limit.test',
      jsonb_build_object('emails',jsonb_build_array(jsonb_build_object('value',id::text||'@limit.test','primary',true))),
      case when $2 then clock_timestamp() end, not $2
    from unnest($4::uuid[]) id`,
    [organizationId, deleted, bound, ids],
  );
}

describe('the SCIM user limit', () => {
  it('counts the people the directory holds, not the ones it has deleted', async () => {
    const { organizationId, pool, principal } = await setup();
    await fill(organizationId, DIRECTORY_LIMITS.users, {
      deleted: true,
      bound: false,
    });

    const created = await createDirectoryUser(pool, principal, person());

    expect(created.deleted_at).toBeNull();
  }, 60_000);

  it('still refuses a user once the live count reaches the limit', async () => {
    const { organizationId, pool, principal } = await setup();
    await fill(organizationId, DIRECTORY_LIMITS.users, {
      deleted: false,
      bound: false,
    });

    const refused = await createDirectoryUser(pool, principal, person()).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(DirectoryError);
    expect((refused as DirectoryError).reason).toBe('limit');
  }, 60_000);

  it('unlinks a workspace that has outlived more people than the limit', async () => {
    const { organizationId, owner, scope, pool, principal } = await setup();
    const target = await db.workspace(owner.id);
    await db.federation().linkWorkspace({
      ...scope,
      targetWorkspaceId: target,
      defaultRole: 'viewer',
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const expected = DIRECTORY_LIMITS.users + 1;
    await fill(organizationId, expected, { deleted: false, bound: true });
    await withDirectoryTransaction(pool, principal, (client, organization) =>
      projectDirectoryMemberships(client, organization),
    );
    const managedRows = async () => {
      const rows = await db.asAdmin<{ count: string }>(
        'select count(*) from app.auth_directory_memberships where workspace_id=$1',
        [target],
      );
      return Number(rows[0]?.count);
    };
    expect(await managedRows()).toBe(expected);

    await unlinkDirectoryWorkspace(pool, {
      ...scope,
      targetWorkspaceId: target,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });

    expect(await managedRows()).toBe(0);
  }, 180_000);
});
