import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { waitFor } from '../support/process.mjs';
import { createReport } from '../support/simulation-report.mjs';
import { signInAtAuthentik } from './support/authentik.mjs';
import {
  APP,
  currentUser,
  openPerson,
  signInWithOrganization,
  limitedSignIns,
} from './support/browser.mjs';
import {
  addOidcProvider,
  createOrganization,
  createProvisioningCredential,
  directoryPeople,
  linkWorkspace,
  members,
  readDirectory,
  replaceMappings,
} from './support/organization.mjs';
import { closeWorld, openWorld, providerLogs } from './support/world.mjs';

// Directory provisioning from real SCIM client software: authentik's SCIM
// provider pushes users and groups to Pertexo while people sign in through
// authentik's OIDC. Access must follow the directory, and deactivation must
// end live sessions, as the guide says. Rerun on a Linux machine with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/single-sign-on/directory-provisioning.test.mjs
const DOMAIN = 'gamma-corp.test';
const password = 'provider-password-7';
const PROVIDER = 'Gamma authentik';
const SYNC = { timeout: 180_000, every: 3_000 };
const record = createReport();

describe('directory provisioning from authentik over SCIM', () => {
  let world;
  let workspaceId;
  let otherWorkspaceId;
  let scim;
  let group;
  const people = {};

  before(async () => {
    world = await openWorld();
    workspaceId = await world.createWorkspace();
    otherWorkspaceId = await world.createWorkspace();
    const { organizationId } = await createOrganization(
      world.client,
      world.network,
      { workspaceId, name: 'Gamma Corp', domains: [DOMAIN] },
    );
    await linkWorkspace(world.client, workspaceId, otherWorkspaceId, 'viewer');
    const oidc = await world.authentik.createOidcApplication({
      slug: 'pertexo-directory',
      clientId: 'pertexo-directory',
      secret: 'ak-directory-secret',
      emailVerified: true,
    });
    // Only provisioned people may sign in: no accounts made on first sign-in.
    await addOidcProvider(world.client, workspaceId, {
      name: PROVIDER,
      issuer: oidc.issuer,
      clientId: 'pertexo-directory',
      secret: 'ak-directory-secret',
      jit: false,
    });
    group = await world.authentik.createGroup('Pertexo builders');
    people.dana = await world.authentik.createUser({
      username: 'dana',
      name: 'Dana Gamma',
      email: `dana@${DOMAIN}`,
      password,
      groups: [group.pk],
    });
    people.erin = await world.authentik.createUser({
      username: 'erin',
      name: 'Erin Gamma',
      email: `erin@${DOMAIN}`,
      password,
    });
    const bearer = await createProvisioningCredential(
      world.client,
      workspaceId,
    );
    scim = await world.authentik.createScimProvider({
      url: `${APP}/v1/auth/federation/scim/${organizationId}/v2`,
      token: bearer,
      application: oidc.application,
      groups: [group.pk],
    });
  });
  after(async () => {
    if (process.exitCode && world) console.error(await providerLogs());
    if (world)
      record('refusals in the API log', { lines: await world.refusals() });
    record('turned away by per-address sign-in budgets', {
      times: limitedSignIns(),
    });
    await closeWorld(world);
  });

  const atAuthentik = (username) => (page) =>
    signInAtAuthentik(page, { username, password });
  const person = (username) => async () =>
    (await directoryPeople(world.client, workspaceId)).find(
      (entry) => entry.email === `${username}@${DOMAIN}`,
    );
  const roleOf = async (target, username) =>
    (await members(world.client, target)).find(
      (member) => member.email === `${username}@${DOMAIN}`,
    )?.role;
  /** Pushes `user` now, so a scenario doesn't wait for authentik's schedule. */
  const push = (user) =>
    world.authentik
      .syncNow(scim, 'authentik.core.models.User', user.pk)
      .catch(() => undefined);

  it('provisions the group member pushed by authentik as awaiting first SSO', async () => {
    await push(people.dana);
    await world.authentik
      .syncNow(scim, 'authentik.core.models.Group', group.pk)
      .catch(() => undefined);
    const dana = await waitFor(person('dana'), {
      what: 'dana in the directory',
      ...SYNC,
    }).catch(async (error) => {
      record('provisioned by SCIM', {
        authentikSyncStatus: await world.authentik.syncStatus(scim),
      });
      throw error;
    });
    const directory = await waitFor(
      async () => {
        const read = await readDirectory(world.client, workspaceId);
        return read.groups.some((entry) => entry.memberCount > 0) && read;
      },
      { what: 'the group with its member', ...SYNC },
    );
    record('provisioned by SCIM', {
      dana,
      groups: directory.groups,
      counts: directory.counts,
    });
    assert.equal(dana.active, true);
    assert.equal(dana.boundUserId, null);
    const builders = directory.groups.find(
      (entry) => entry.displayName === 'Pertexo builders',
    );
    assert.ok(builders, JSON.stringify(directory.groups));
    await replaceMappings(world.client, workspaceId, [
      {
        groupId: builders.id,
        workspaceId,
        role: 'builder',
        priority: 0,
      },
    ]);
  });

  let dana;
  let danaId;
  it('binds the directory record on first sign-in and gives the mapped and default roles', async () => {
    dana = await openPerson(world.browser);
    const landed = await signInWithOrganization(dana.page, {
      domain: DOMAIN,
      provider: PROVIDER,
      atProvider: atAuthentik('dana'),
    });
    const me = await currentUser(dana.page);
    danaId = me.user?.id;
    const roles = {
      control: await roleOf(workspaceId, 'dana'),
      other: await roleOf(otherWorkspaceId, 'dana'),
    };
    const bound = await person('dana')();
    record('first sign-in of a provisioned person', { landed, roles, bound });
    assert.equal(landed.signedIn, true, JSON.stringify(landed));
    assert.equal(bound.boundUserId, danaId);
    assert.equal(roles.control, 'builder');
    assert.equal(roles.other, 'viewer');
  });

  it('lets in only people the directory provisioned when new accounts are off', async () => {
    await push(people.erin);
    const provisioned = await waitFor(person('erin'), {
      what: 'erin to be provisioned or not',
      timeout: 20_000,
      every: 2_000,
    }).catch(() => undefined);
    const erin = await openPerson(world.browser);
    const landed = await signInWithOrganization(erin.page, {
      domain: DOMAIN,
      provider: PROVIDER,
      atProvider: atAuthentik('erin'),
    });
    record('a person outside the synced group', {
      provisioned: provisioned ?? null,
      landed,
    });
    // authentik's group filter decides whether erin is pushed; Pertexo must
    // follow the directory either way.
    assert.equal(landed.signedIn, provisioned !== undefined);
    await erin.close();
  });

  it("doesn't rename the account when the directory renames the person", async () => {
    const { revision } = await person('dana')();
    await world.authentik.updateUser(people.dana.pk, { name: 'Dana Renamed' });
    await push(people.dana);
    // The directory record changes when authentik's update arrives.
    const updated = await waitFor(
      async () => {
        const entry = await person('dana')();
        return entry.revision > revision && entry;
      },
      { what: "authentik's update of dana", ...SYNC },
    );
    const me = await currentUser(dana.page);
    record('renamed in the directory', {
      directoryRevision: updated.revision,
      accountName: me.user?.displayName,
      sessionStatus: me.status,
    });
    assert.equal(me.status, 200);
    assert.notEqual(me.user.displayName, 'Dana Renamed');
  });

  it('lowers the role and ends the session when the person leaves the mapped group', async () => {
    await world.authentik.setGroupMembers(group.pk, []);
    await world.authentik
      .syncNow(scim, 'authentik.core.models.Group', group.pk)
      .catch(() => undefined);
    const role = await waitFor(
      async () => {
        const current = await roleOf(workspaceId, 'dana');
        return current !== 'builder' && (current ?? 'none');
      },
      { what: "dana's role to follow the group", ...SYNC },
    );
    const session = await currentUser(dana.page);
    record('left the mapped group', { role, sessionStatus: session.status });
    assert.equal(role, 'viewer');
    assert.equal(session.status, 401);
  });

  it('removes access and ends the live session when the person is deactivated', async () => {
    await world.authentik.setGroupMembers(group.pk, [people.dana.pk]);
    const back = await signInWithOrganization(dana.page, {
      domain: DOMAIN,
      provider: PROVIDER,
    });
    assert.equal(back.signedIn, true, JSON.stringify(back));
    await world.authentik.updateUser(people.dana.pk, { is_active: false });
    await push(people.dana);
    const deactivated = await waitFor(
      async () => {
        const entry = await person('dana')();
        return entry?.active === false && entry;
      },
      { what: 'dana deactivated in the directory', ...SYNC },
    );
    const session = await currentUser(dana.page);
    const roles = {
      control: (await roleOf(workspaceId, 'dana')) ?? null,
      other: (await roleOf(otherWorkspaceId, 'dana')) ?? null,
    };
    record('deactivated', {
      directory: deactivated,
      sessionStatus: session.status,
      roles,
    });
    assert.equal(session.status, 401);
    assert.equal(roles.control, null);
    assert.equal(roles.other, null);
  });

  it('gives the same account its mapped access back when the directory reactivates the person', async () => {
    await world.authentik.updateUser(people.dana.pk, { is_active: true });
    await push(people.dana);
    await waitFor(async () => (await person('dana')())?.active === true, {
      what: 'dana reactivated in the directory',
      ...SYNC,
    });
    const before = (await roleOf(workspaceId, 'dana')) ?? null;
    const landed = await signInWithOrganization(dana.page, {
      domain: DOMAIN,
      provider: PROVIDER,
      atProvider: atAuthentik('dana'),
    });
    const after = (await roleOf(workspaceId, 'dana')) ?? null;
    const me = await currentUser(dana.page);
    record('reactivated', {
      roleBeforeSignIn: before,
      landed,
      roleAfterSignIn: after,
    });
    assert.equal(landed.signedIn, true, JSON.stringify(landed));
    assert.equal(me.user.id, danaId);
    assert.equal(after, 'builder');
  });

  it('removes access and ends the session when the person is deleted, keeping a tombstone', async () => {
    await world.authentik.deleteUser(people.dana.pk);
    const tombstone = await waitFor(
      async () => {
        const entry = await person('dana')();
        return (entry === undefined || entry.deleted) && (entry ?? 'gone');
      },
      { what: 'dana deleted in the directory', ...SYNC },
    );
    const session = await currentUser(dana.page);
    const role = (await roleOf(workspaceId, 'dana')) ?? null;
    const counts = (await readDirectory(world.client, workspaceId)).counts;
    record('deleted', {
      tombstone,
      sessionStatus: session.status,
      role,
      counts,
    });
    assert.equal(session.status, 401);
    assert.equal(role, null);
    await dana.close();
  });
});
