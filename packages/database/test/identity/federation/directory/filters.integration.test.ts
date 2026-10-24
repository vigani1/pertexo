import { randomUUID } from 'node:crypto';
import { parse } from 'scim2-parse-filter';
import { describe, expect, it } from 'vitest';
import { useIdentityCommandDatabase } from '../../command.support.js';
import { createDirectoryUser } from '../../../../src/identity/federation/provisioning/resources/users.repository.js';
import { createDirectoryGroup } from '../../../../src/identity/federation/provisioning/resources/groups.repository.js';
import {
  listDirectoryUsers,
  listDirectoryGroups,
  type DirectoryQuery,
} from '../../../../src/identity/federation/provisioning/resources/records.queries.js';
import { withDirectoryRead } from '../../../../src/identity/federation/provisioning/authority.repository.js';

const db = useIdentityCommandDatabase('scim_filter');
async function setup() {
  const owner = await db.user('Filter owner'),
    workspaceId = await db.workspace(owner.id);
  const organization = (
    await db.federation().createOrganization({
      workspaceId,
      actorId: owner.id,
      name: 'Filter',
      idempotencyKey: randomUUID(),
    })
  ).organization;
  if (organization === null) throw new Error('Missing directory organization');
  const credentialId = randomUUID();
  await db.asAdmin(
    'insert into app.auth_provisioning_credentials(id,organization_id,name,secret_digest) values($1,$2,$3,$4)',
    [credentialId, organization.id, 'Filters', 'a'.repeat(64)],
  );
  const principal = {
      organizationId: organization.id,
      controlWorkspaceId: workspaceId,
      credentialId,
    },
    pool = db.authenticationPool();
  const one = await createDirectoryUser(pool, principal, {
    userName: 'MixedCase',
    externalId: 'ExactID',
    active: true,
    profile: {
      displayName: 'Zulu',
      emails: [{ value: 'first@example.test', type: 'work', primary: true }],
      name: { givenName: 'First' },
    },
  });
  const two = await createDirectoryUser(pool, principal, {
    userName: 'second',
    externalId: 'exactid',
    active: false,
    profile: {
      displayName: 'Alpha',
      emails: [{ value: 'second@example.test', type: 'home', primary: true }],
    },
  });
  const group = await createDirectoryGroup(pool, principal, {
    displayName: 'Builders',
    externalId: null,
    memberIds: [one.id],
  });
  const list = (source?: string, extra: Partial<DirectoryQuery> = {}) =>
    withDirectoryRead(pool, principal, (client) =>
      listDirectoryUsers(client, organization.id, {
        startIndex: 1,
        count: 100,
        sortOrder: 'ascending',
        ...(source === undefined ? {} : { filter: parse(source) }),
        ...extra,
      }),
    );
  return { pool, principal, organization, one, two, group, list };
}
describe('schema-aware parameterized SCIM filtering', () => {
  it('uses schema caseExact rules, negation and same-element value filters', async () => {
    const f = await setup();
    expect(
      (await f.list('userName eq "MIXEDCASE"')).Resources.map(
        (user) => user.id,
      ),
    ).toEqual([f.one.id]);
    expect(
      (await f.list('externalId eq "ExactID"')).Resources.map(
        (user) => user.id,
      ),
    ).toEqual([f.one.id]);
    expect(
      (
        await f.list(
          'not (emails[type eq "work" and value eq "FIRST@example.test"])',
        )
      ).Resources.map((user) => user.id),
    ).toEqual([f.two.id]);
    expect(
      (
        await f.list(`groups[value eq "${f.group.id}"] and active eq true`)
      ).Resources.map((user) => user.id),
    ).toEqual([f.one.id]);
    expect(
      (await f.list('name.givenName sw "fir"')).Resources.map(
        (user) => user.id,
      ),
    ).toEqual([f.one.id]);
    expect(
      (await f.list('displayName ew "HA"')).Resources.map((user) => user.id),
    ).toEqual([f.two.id]);
  });
  it('pages and sorts in the database, returns totals for count zero, and handles members', async () => {
    const f = await setup();
    const page = await f.list(undefined, {
      sortBy: 'displayName',
      count: 1,
      startIndex: 2,
    });
    expect(page.totalResults).toBe(2);
    expect(page.Resources.map((user) => user.id)).toEqual([f.one.id]);
    expect((await f.list(undefined, { count: 0 })).Resources).toEqual([]);
    const groups = await withDirectoryRead(f.pool, f.principal, (client) =>
      listDirectoryGroups(client, f.organization.id, {
        filter: parse(`members.value eq "${f.one.id}"`),
        startIndex: 1,
        count: 100,
        sortOrder: 'ascending',
      }),
    );
    expect(groups.Resources.map((group) => group.id)).toEqual([f.group.id]);
  });
  it('treats SQL-looking values as data and refuses unsupported attributes and incompatible comparisons', async () => {
    const f = await setup();
    expect((await f.list('userName eq "\' OR true --"')).totalResults).toBe(0);
    for (const source of [
      'password pr',
      'active co "true"',
      'meta.created gt "not-a-date"',
      'emails[password pr]',
    ])
      await expect(f.list(source)).rejects.toHaveProperty(
        'reason',
        'invalid_filter',
      );
    expect((await f.list()).totalResults).toBe(2);
  });
});
