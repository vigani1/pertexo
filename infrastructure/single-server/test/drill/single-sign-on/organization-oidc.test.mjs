import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createReport } from '../support/simulation-report.mjs';
import { signInAtAuthentik } from './support/authentik.mjs';
import {
  currentUser,
  landing,
  openPerson,
  signInWithOrganization,
  signInWithPassword,
  signOut,
  testProvider,
  workspacesOf,
  limitedSignIns,
  waitForFreshSignInBudget,
} from './support/browser.mjs';
import { signInAtKeycloak } from './support/keycloak.mjs';
import {
  addOidcProvider,
  createOrganization,
  linkWorkspace,
  members,
} from './support/organization.mjs';
import { closeWorld, openWorld, providerLogs } from './support/world.mjs';

// Organization sign-in over OIDC against two real providers, Keycloak and
// authentik, on the production server. Rerun on a Linux machine with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/single-sign-on/organization-oidc.test.mjs
const DOMAIN = 'alpha-corp.test';
const password = 'provider-password-7';
const record = createReport();
/** People behind one office address, and how many sign in at once. */
const OFFICE_SIZE = 40;
const OFFICE_LANES = 4;

describe('organization sign-in with OIDC providers', () => {
  let world;
  let workspaceId;
  let joinedWorkspaceId;
  let domainId;
  let realm;
  const providers = {};
  let owner;

  before(async () => {
    world = await openWorld();
    workspaceId = await world.createWorkspace();
    joinedWorkspaceId = await world.createWorkspace();
    const organization = await createOrganization(world.client, world.network, {
      workspaceId,
      name: 'Alpha Corp',
      domains: [DOMAIN],
    });
    domainId = organization.domainIds[DOMAIN];
    await linkWorkspace(
      world.client,
      workspaceId,
      joinedWorkspaceId,
      'builder',
    );

    realm = await world.keycloak.createRealm('alpha');
    await realm.createOidcClient({
      clientId: 'pertexo',
      secret: 'kc-secret-1',
    });
    for (const [username, emailVerified] of [
      ['alice', true],
      ['bob', false],
    ])
      await realm.createUser({
        username,
        email: `${username}@${DOMAIN}`,
        firstName: username,
        password,
        emailVerified,
      });
    providers.keycloak = await addOidcProvider(world.client, workspaceId, {
      name: 'Alpha Keycloak',
      issuer: realm.issuer,
      clientId: 'pertexo',
      secret: 'kc-secret-1',
    });

    const unverified = await world.authentik.createOidcApplication({
      slug: 'pertexo-default',
      clientId: 'pertexo-default',
      secret: 'ak-secret-1',
      emailVerified: false,
    });
    const verified = await world.authentik.createOidcApplication({
      slug: 'pertexo-verified',
      clientId: 'pertexo-verified',
      secret: 'ak-secret-2',
      emailVerified: true,
    });
    await world.authentik.createUser({
      username: 'ada',
      name: 'Ada Alpha',
      email: `ada@${DOMAIN}`,
      password,
    });
    providers.authentikDefault = await addOidcProvider(
      world.client,
      workspaceId,
      {
        name: 'Alpha authentik defaults',
        issuer: unverified.issuer,
        clientId: 'pertexo-default',
        secret: 'ak-secret-1',
      },
    );
    providers.authentik = await addOidcProvider(world.client, workspaceId, {
      name: 'Alpha authentik',
      issuer: verified.issuer,
      clientId: 'pertexo-verified',
      secret: 'ak-secret-2',
    });
    owner = await openPerson(world.browser);
    await signInWithPassword(owner.page, world.owner);
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

  const keycloakSignIn = (username) => (page) =>
    signInAtKeycloak(page, { username, password });
  const authentikSignIn = (username) => (page) =>
    signInAtAuthentik(page, { username, password });
  let alice;
  let aliceId;

  it('creates the account on the first Keycloak sign-in and joins every linked workspace', async () => {
    alice = await openPerson(world.browser);
    const landed = await signInWithOrganization(alice.page, {
      domain: DOMAIN,
      provider: 'Alpha Keycloak',
      atProvider: keycloakSignIn('alice'),
    });
    const me = await currentUser(alice.page);
    const workspaces = await workspacesOf(alice.page);
    const roles = Object.fromEntries(
      (await members(world.client, joinedWorkspaceId)).map((member) => [
        member.email,
        member.role,
      ]),
    );
    record('first sign-in (Keycloak)', {
      landed,
      email: me.user?.email,
      workspaces: workspaces.items.map((item) => item.id ?? item.workspace?.id),
      roleInJoinedWorkspace: roles[`alice@${DOMAIN}`],
    });
    assert.equal(landed.signedIn, true, JSON.stringify(landed));
    assert.equal(me.status, 200);
    assert.equal(me.user.email, `alice@${DOMAIN}`);
    aliceId = me.user.id;
    const reachable = JSON.stringify(workspaces.items);
    assert.ok(reachable.includes(workspaceId), reachable);
    assert.ok(reachable.includes(joinedWorkspaceId), reachable);
    assert.equal(roles[`alice@${DOMAIN}`], 'builder');
  });

  it('signs out, and the next sign-in reuses the same account', async () => {
    await signOut(alice.page);
    const afterSignOut = await currentUser(alice.page);
    // No single logout is claimed: Keycloak keeps its own session, so the next
    // sign-in goes straight through without a password.
    const landed = await signInWithOrganization(alice.page, {
      domain: DOMAIN,
      provider: 'Alpha Keycloak',
    });
    const me = await currentUser(alice.page);
    record('sign-out and second sign-in', {
      statusAfterSignOut: afterSignOut.status,
      secondSignIn: landed,
      sameAccount: me.user?.id === aliceId,
      keycloakAskedAgain: false,
    });
    assert.equal(afterSignOut.status, 401);
    assert.equal(landed.signedIn, true, JSON.stringify(landed));
    assert.equal(me.user.id, aliceId);
  });

  it('keeps the Pertexo session when Keycloak signs everyone out, as no single logout is claimed', async () => {
    await realm.signOutEveryone();
    const me = await currentUser(alice.page);
    record('provider-side sign-out', { pertexoSessionStatus: me.status });
    assert.equal(me.status, 200);
  });

  it('refuses a replayed authorization callback, in the same and in another browser', async () => {
    const callback = alice.callbacks.find((entry) => entry.protocol === 'oidc');
    const stranger = await openPerson(world.browser);
    await stranger.page.goto(callback.url);
    const elsewhere = await landing(stranger.page);
    const strangerUser = await currentUser(stranger.page);
    await alice.page.goto(callback.url);
    const again = await landing(alice.page);
    record('replayed callback', {
      elsewhere,
      again,
      strangerStatus: strangerUser.status,
    });
    assert.equal(elsewhere.signedIn, false);
    assert.equal(strangerUser.status, 401);
    assert.match(elsewhere.notice ?? '', /did not finish/u);
    await stranger.close();
  });

  it('keeps signing in after Keycloak rotates its signing key', async () => {
    await realm.rotateSigningKey();
    const person = await openPerson(world.browser);
    const landed = await signInWithOrganization(person.page, {
      domain: DOMAIN,
      provider: 'Alpha Keycloak',
      atProvider: keycloakSignIn('alice'),
    });
    const me = await currentUser(person.page);
    record('rotated signing key (Keycloak OIDC)', {
      landed,
      sameAccount: me.user?.id === aliceId,
    });
    assert.equal(landed.signedIn, true, JSON.stringify(landed));
    assert.equal(me.user.id, aliceId);
    await person.close();
  });

  it('follows the provider subject when the email changes inside the domain, without renaming the account', async () => {
    await realm.updateUser('alice', { email: `alice.renamed@${DOMAIN}` });
    const person = await openPerson(world.browser);
    const landed = await signInWithOrganization(person.page, {
      domain: DOMAIN,
      provider: 'Alpha Keycloak',
      atProvider: keycloakSignIn('alice'),
    });
    const me = await currentUser(person.page);
    record('email changed at the provider (inside the domain)', {
      landed,
      sameAccount: me.user?.id === aliceId,
      accountEmail: me.user?.email,
    });
    assert.equal(landed.signedIn, true, JSON.stringify(landed));
    assert.equal(me.user.id, aliceId);
    assert.equal(me.user.email, `alice@${DOMAIN}`);
    await person.close();
  });

  it('refuses an address outside the verified domain, and tells the owner why', async () => {
    await realm.updateUser('alice', { email: 'alice@elsewhere.test' });
    const person = await openPerson(world.browser);
    const landed = await signInWithOrganization(person.page, {
      domain: DOMAIN,
      provider: 'Alpha Keycloak',
      atProvider: keycloakSignIn('alice'),
    });
    const tested = await testProvider(owner.page, {
      protocol: 'oidc',
      workspaceId,
      domainId,
      providerId: providers.keycloak,
      atProvider: keycloakSignIn('alice'),
    });
    record('email moved outside the domain', { landed, ownerTest: tested });
    await realm.updateUser('alice', { email: `alice@${DOMAIN}` });
    assert.equal(landed.signedIn, false, JSON.stringify(landed));
    assert.equal(tested.result, 'failed');
    assert.equal(tested.reason, 'email_domain');
    await person.close();
  });

  it('refuses an email the provider marks unverified, and tells the owner why', async () => {
    const person = await openPerson(world.browser);
    const landed = await signInWithOrganization(person.page, {
      domain: DOMAIN,
      provider: 'Alpha Keycloak',
      atProvider: keycloakSignIn('bob'),
    });
    const user = await currentUser(person.page);
    record('unverified email (Keycloak)', {
      landed,
      sessionStatus: user.status,
    });
    assert.equal(landed.signedIn, false, JSON.stringify(landed));
    assert.equal(user.status, 401);
    await person.close();
  });

  it("refuses authentik's default mapping, which calls every address unverified, and says so to the owner", async () => {
    const person = await openPerson(world.browser);
    const landed = await signInWithOrganization(person.page, {
      domain: DOMAIN,
      provider: 'Alpha authentik defaults',
      atProvider: authentikSignIn('ada'),
    });
    const ownerSide = await openPerson(world.browser);
    await signInWithPassword(ownerSide.page, world.owner);
    const tested = await testProvider(ownerSide.page, {
      protocol: 'oidc',
      workspaceId,
      domainId,
      providerId: providers.authentikDefault,
      atProvider: authentikSignIn('ada'),
    });
    record("authentik's default email mapping", { landed, ownerTest: tested });
    assert.equal(landed.signedIn, false, JSON.stringify(landed));
    assert.equal(tested.reason, 'oidc_email_unverified');
    await person.close();
    await ownerSide.close();
  });

  let ada;
  let adaId;
  it('creates the account on the first authentik sign-in and reuses it on the second', async () => {
    ada = await openPerson(world.browser);
    const first = await signInWithOrganization(ada.page, {
      domain: DOMAIN,
      provider: 'Alpha authentik',
      atProvider: authentikSignIn('ada'),
    });
    const me = await currentUser(ada.page);
    adaId = me.user?.id;
    await signOut(ada.page);
    const second = await signInWithOrganization(ada.page, {
      domain: DOMAIN,
      provider: 'Alpha authentik',
    });
    const again = await currentUser(ada.page);
    record('authentik first and second sign-in', {
      first,
      second,
      sameAccount: again.user?.id === adaId,
    });
    assert.equal(first.signedIn, true, JSON.stringify(first));
    assert.equal(second.signedIn, true, JSON.stringify(second));
    assert.equal(again.user.id, adaId);
  });

  // A provider whose clock is a few minutes off still has to work: hosts drift
  // and Pertexo documents no tighter OIDC bound. Ten minutes is past the
  // tokens' own lifetime and is recorded, not required.
  for (const seconds of [90, -90, 240, -240, 600, -600]) {
    const required = Math.abs(seconds) <= 240;
    it(`${required ? 'signs in' : 'records sign-in'} with authentik's clock ${seconds > 0 ? 'ahead' : 'behind'} by ${Math.abs(seconds)} seconds`, async () => {
      world.authentik.setClockOffset(seconds);
      const person = await openPerson(world.browser);
      try {
        const landed = await signInWithOrganization(person.page, {
          domain: DOMAIN,
          provider: 'Alpha authentik',
          atProvider: authentikSignIn('ada'),
        });
        const me = await currentUser(person.page);
        record(`authentik clock ${seconds > 0 ? '+' : ''}${seconds}s (OIDC)`, {
          landed,
          sameAccount: me.user?.id === adaId,
        });
        if (required) {
          assert.equal(landed.signedIn, true, JSON.stringify(landed));
          assert.equal(me.user.id, adaId);
        }
      } finally {
        world.authentik.setClockOffset(0);
        await person.close();
      }
    });
  }

  // Everyone at an office reaches the server from one address, and they arrive
  // together. Forty people in four lanes sign in through Keycloak with no
  // retries: the login page, the SSO start and the callback each have a budget
  // sized for an office, while password and two-factor guessing keep theirs.
  it('lets forty people at one office address sign in within a minute', async () => {
    const office = Array.from(
      { length: OFFICE_SIZE },
      (_, index) => `office${index}`,
    );
    for (const username of office)
      await realm.createUser({
        username,
        email: `${username}@${DOMAIN}`,
        firstName: username,
        password,
      });
    // Start from a fresh budget window, as the first arrivals of a morning do.
    await waitForFreshSignInBudget();
    const started = Date.now();
    const outcomes = [];
    const queue = [...office];
    const lane = async () => {
      for (let username = queue.shift(); username; username = queue.shift()) {
        const person = await openPerson(world.browser);
        try {
          const landed = await signInWithOrganization(person.page, {
            domain: DOMAIN,
            provider: 'Alpha Keycloak',
            atProvider: keycloakSignIn(username),
            retry: false,
          });
          outcomes.push({
            username,
            signedIn: landed.signedIn,
            shown: landed.notice,
          });
        } finally {
          await person.close();
        }
      }
    };
    await Promise.all(Array.from({ length: OFFICE_LANES }, lane));
    const seconds = Math.round((Date.now() - started) / 1000);
    record('forty people from one office address', {
      seconds,
      lanes: OFFICE_LANES,
      signedIn: outcomes.filter((outcome) => outcome.signedIn).length,
      turnedAway: outcomes.filter((outcome) => !outcome.signedIn),
    });
    assert.deepEqual(
      outcomes.filter((outcome) => !outcome.signedIn),
      [],
    );
    assert.equal(outcomes.length, OFFICE_SIZE);
    assert.ok(seconds <= 60, `took ${seconds}s`);
  });
});
