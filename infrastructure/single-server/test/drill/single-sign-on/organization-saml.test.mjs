import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createReport } from '../support/simulation-report.mjs';
import { signInAtAuthentik } from './support/authentik.mjs';
import {
  currentUser,
  openPerson,
  postSamlResponse,
  signInWithOrganization,
  signInWithPassword,
  signOut,
  tamperNextSamlResponse,
  testProvider,
  workspacesOf,
  limitedSignIns,
} from './support/browser.mjs';
import { signInAtKeycloak } from './support/keycloak.mjs';
import {
  addSamlProvider,
  createOrganization,
  replaceSamlCertificates,
  samlServiceProvider,
} from './support/organization.mjs';
import {
  replaceEmail,
  unsigned,
  wrapForgedBefore,
  wrapGenuineInExtensions,
} from './support/saml-response.mjs';
import { closeWorld, openWorld, providerLogs } from './support/world.mjs';

// Organization sign-in over SAML against two real providers, Keycloak and
// authentik, on the production server: the guide's setup, then the ways real
// responses go wrong or get attacked. Rerun on a Linux machine with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/single-sign-on/organization-saml.test.mjs
const DOMAIN = 'alpha-corp.test';
const password = 'provider-password-7';
const KEYCLOAK = 'Alpha Keycloak SAML';
const AUTHENTIK = 'Alpha authentik SAML';
const record = createReport();

describe('organization sign-in with SAML providers', () => {
  let world;
  let workspaceId;
  let domainId;
  let realm;
  let samlClient;
  let authentikSaml;
  const providers = {};
  let owner;

  before(async () => {
    world = await openWorld();
    workspaceId = await world.createWorkspace();
    const organization = await createOrganization(world.client, world.network, {
      workspaceId,
      name: 'Alpha Corp',
      domains: [DOMAIN],
    });
    domainId = organization.domainIds[DOMAIN];
    const sp = await samlServiceProvider(world.client, workspaceId);

    realm = await world.keycloak.createRealm('alpha');
    // A new Keycloak SAML client signs the document only, by default.
    samlClient = await realm.createSamlClient(sp.xml, {
      signDocument: true,
      signAssertion: false,
    });
    for (const username of ['alice', 'mallory'])
      await realm.createUser({
        username,
        email: `${username}@${DOMAIN}`,
        firstName: username,
        password,
      });
    providers.keycloak = await addSamlProvider(world.client, workspaceId, {
      name: KEYCLOAK,
      issuer: realm.samlEntityId,
      signInUrl: realm.samlSignInUrl,
      certificates: await realm.samlCertificates(),
    });

    authentikSaml = await world.authentik.createSamlApplication({
      slug: 'pertexo-saml',
      entityId: sp.entityId,
      acsUrl: sp.redirectUri,
    });
    await world.authentik.createUser({
      username: 'ada',
      name: 'Ada Alpha',
      email: `ada@${DOMAIN}`,
      password,
    });
    providers.authentik = await addSamlProvider(world.client, workspaceId, {
      name: AUTHENTIK,
      issuer: authentikSaml.issuer,
      signInUrl: authentikSaml.signInUrl,
      certificates: [await world.authentik.signingCertificate()],
      emailAttribute: authentikSaml.emailAttribute,
      nameAttribute: authentikSaml.nameAttribute,
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

  const atKeycloak = (username) => (page) =>
    signInAtKeycloak(page, { username, password });
  const atAuthentik = (username) => (page) =>
    signInAtAuthentik(page, { username, password });
  /** One sign-in in a fresh browser; returns where it landed and the session. */
  const attempt = async (provider, atProvider, prepare, timeout) => {
    const person = await openPerson(world.browser);
    try {
      const tampered = prepare?.(person.page);
      const landed = await signInWithOrganization(person.page, {
        domain: DOMAIN,
        provider,
        atProvider,
        timeout,
      });
      await tampered;
      const me = await currentUser(person.page);
      return { landed, user: me.user, status: me.status };
    } finally {
      await person.close();
    }
  };
  const ownerTest = (providerId, atProvider) =>
    testProvider(owner.page, {
      protocol: 'saml',
      workspaceId,
      domainId,
      providerId,
      atProvider,
    });

  it('refuses a Keycloak client left signing only the document, and tells the owner to sign both', async () => {
    const tried = await attempt(KEYCLOAK, atKeycloak('alice'));
    const tested = await ownerTest(providers.keycloak, atKeycloak('alice'));
    record('Keycloak default signing (document only)', {
      landed: tried.landed,
      ownerTest: tested,
    });
    assert.equal(tried.landed.signedIn, false, JSON.stringify(tried.landed));
    assert.equal(tested.reason, 'saml_signature_count');
  });

  let alice;
  let aliceId;
  it('creates the account on the first sign-in once both are signed, and reuses it after sign-out', async () => {
    await realm.updateSamlClient(samlClient, {
      'saml.assertion.signature': 'true',
    });
    alice = await openPerson(world.browser);
    const first = await signInWithOrganization(alice.page, {
      domain: DOMAIN,
      provider: KEYCLOAK,
      atProvider: atKeycloak('alice'),
    });
    const me = await currentUser(alice.page);
    aliceId = me.user?.id;
    const workspaces = await workspacesOf(alice.page);
    await signOut(alice.page);
    const signedOut = await currentUser(alice.page);
    const second = await signInWithOrganization(alice.page, {
      domain: DOMAIN,
      provider: KEYCLOAK,
      atProvider: atKeycloak('alice'),
    });
    const again = await currentUser(alice.page);
    record('Keycloak SAML first and second sign-in', {
      first,
      second,
      email: me.user?.email,
      joinedControlWorkspace: JSON.stringify(workspaces.items).includes(
        workspaceId,
      ),
      statusAfterSignOut: signedOut.status,
      sameAccount: again.user?.id === aliceId,
    });
    assert.equal(first.signedIn, true, JSON.stringify(first));
    assert.equal(me.user.email, `alice@${DOMAIN}`);
    assert.ok(JSON.stringify(workspaces.items).includes(workspaceId));
    assert.equal(signedOut.status, 401);
    assert.equal(second.signedIn, true, JSON.stringify(second));
    assert.equal(again.user.id, aliceId);
  });

  it('refuses a replayed response, in another browser and in the same one', async () => {
    const captured = alice.callbacks.find((entry) => entry.protocol === 'saml');
    const stranger = await openPerson(world.browser);
    const elsewhere = await postSamlResponse(stranger.page, captured.body);
    const strangerUser = await currentUser(stranger.page);
    await signOut(alice.page);
    const again = await postSamlResponse(alice.page, captured.body);
    const aliceUser = await currentUser(alice.page);
    record('replayed SAML response', {
      elsewhere,
      again,
      strangerStatus: strangerUser.status,
      sameBrowserStatus: aliceUser.status,
    });
    assert.equal(elsewhere.signedIn, false);
    assert.equal(strangerUser.status, 401);
    assert.equal(again.signedIn, false);
    assert.equal(aliceUser.status, 401);
    await stranger.close();
  });

  // Mallory has a real account at the provider and edits her own response in
  // flight to become Alice. Every edit must be refused without a session.
  for (const [name, transform] of [
    ['an email edited inside the signed assertion', replaceEmail],
    ['a forged assertion placed before the signed one', wrapForgedBefore],
    ['the signed assertion hidden in Extensions', wrapGenuineInExtensions],
    ['both signatures removed', unsigned],
  ])
    it(`refuses ${name}`, async () => {
      const tried = await attempt(KEYCLOAK, atKeycloak('mallory'), (page) =>
        tamperNextSamlResponse(page, (body) =>
          transform(body, `alice@${DOMAIN}`),
        ),
      );
      record(`tampered response: ${name}`, {
        landed: tried.landed,
        sessionStatus: tried.status,
      });
      assert.equal(tried.landed.signedIn, false, JSON.stringify(tried.landed));
      assert.equal(tried.status, 401);
    });

  it('refuses a provider configured to sign nothing, and tells the owner', async () => {
    await realm.updateSamlClient(samlClient, {
      'saml.server.signature': 'false',
      'saml.assertion.signature': 'false',
    });
    try {
      const tried = await attempt(KEYCLOAK, atKeycloak('alice'));
      const tested = await ownerTest(providers.keycloak, atKeycloak('alice'));
      record('Keycloak signing turned off', {
        landed: tried.landed,
        ownerTest: tested,
      });
      assert.equal(tried.landed.signedIn, false);
      assert.equal(tested.reason, 'saml_signature_count');
    } finally {
      await realm.updateSamlClient(samlClient, {
        'saml.server.signature': 'true',
        'saml.assertion.signature': 'true',
      });
    }
  });

  it('refuses a rotated Keycloak key until the owner adds it, then keeps working through the rotation', async () => {
    const before = await realm.samlCertificates();
    await realm.rotateSigningKey();
    const after = await realm.samlCertificates();
    const added = after.filter((certificate) => !before.includes(certificate));
    const refused = await attempt(KEYCLOAK, atKeycloak('alice'));
    const tested = await ownerTest(providers.keycloak, atKeycloak('alice'));
    await replaceSamlCertificates(
      world.client,
      workspaceId,
      providers.keycloak,
      [before[0], added[0]],
    );
    const both = await attempt(KEYCLOAK, atKeycloak('alice'));
    await replaceSamlCertificates(
      world.client,
      workspaceId,
      providers.keycloak,
      [added[0]],
    );
    const onlyNew = await attempt(KEYCLOAK, atKeycloak('alice'));
    record('rotated Keycloak signing key', {
      certificatesBefore: before.length,
      certificatesAfter: after.length,
      beforeOwnerAddsIt: refused.landed,
      ownerTest: tested,
      withBothCertificates: both.landed,
      withOnlyTheNewOne: onlyNew.landed,
    });
    assert.equal(added.length, 1);
    assert.equal(refused.landed.signedIn, false);
    assert.equal(tested.reason, 'saml_signature_invalid');
    assert.equal(both.landed.signedIn, true, JSON.stringify(both.landed));
    assert.equal(both.user.id, aliceId);
    assert.equal(onlyNew.landed.signedIn, true, JSON.stringify(onlyNew.landed));
  });

  it('keeps the account when the provider changes the email inside the domain', async () => {
    await realm.updateUser('alice', { email: `alice.renamed@${DOMAIN}` });
    const tried = await attempt(KEYCLOAK, atKeycloak('alice'));
    await realm.updateUser('alice', { email: `alice@${DOMAIN}` });
    record('email changed at the provider (SAML)', {
      landed: tried.landed,
      sameAccount: tried.user?.id === aliceId,
      accountEmail: tried.user?.email,
    });
    assert.equal(tried.landed.signedIn, true, JSON.stringify(tried.landed));
    assert.equal(tried.user.id, aliceId);
    assert.equal(tried.user.email, `alice@${DOMAIN}`);
  });

  let adaId;
  it('creates the account on the first authentik sign-in and reuses it on the second', async () => {
    const ada = await openPerson(world.browser);
    const first = await signInWithOrganization(ada.page, {
      domain: DOMAIN,
      provider: AUTHENTIK,
      atProvider: atAuthentik('ada'),
    });
    adaId = (await currentUser(ada.page)).user?.id;
    await signOut(ada.page);
    const second = await signInWithOrganization(ada.page, {
      domain: DOMAIN,
      provider: AUTHENTIK,
      atProvider: atAuthentik('ada'),
    });
    const again = await currentUser(ada.page);
    record('authentik SAML first and second sign-in', {
      first,
      second,
      sameAccount: again.user?.id === adaId,
    });
    assert.equal(first.signedIn, true, JSON.stringify(first));
    assert.equal(second.signedIn, true, JSON.stringify(second));
    assert.equal(again.user.id, adaId);
    await ada.close();
  });

  it('refuses an assertion for another audience, and tells the owner', async () => {
    await world.authentik.updateSamlProvider(authentikSaml.providerId, {
      audience: 'https://wrong.example/sp',
    });
    try {
      const tried = await attempt(AUTHENTIK, atAuthentik('ada'));
      const tested = await ownerTest(providers.authentik, atAuthentik('ada'));
      record('wrong audience (authentik)', {
        landed: tried.landed,
        ownerTest: tested,
      });
      assert.equal(tried.landed.signedIn, false);
      assert.equal(tested.reason, 'saml_audience');
    } finally {
      const sp = await samlServiceProvider(world.client, workspaceId);
      await world.authentik.updateSamlProvider(authentikSaml.providerId, {
        audience: sp.entityId,
      });
    }
  });

  it('refuses an assertion that expired on the way, past the allowed clock skew', async () => {
    await world.authentik.updateSamlProvider(authentikSaml.providerId, {
      assertion_valid_not_on_or_after: 'seconds=5',
    });
    // Valid for five seconds, plus the two minutes of skew the guide allows.
    const held = 5_000 + 120_000 + 15_000;
    try {
      const tried = await attempt(
        AUTHENTIK,
        atAuthentik('ada'),
        (page) =>
          tamperNextSamlResponse(page, (body) => body, { delayMillis: held }),
        held + 60_000,
      );
      record('assertion expired before it arrived', {
        heldMillis: held,
        landed: tried.landed,
        sessionStatus: tried.status,
      });
      assert.equal(tried.landed.signedIn, false);
      assert.equal(tried.status, 401);
    } finally {
      await world.authentik.updateSamlProvider(authentikSaml.providerId, {
        assertion_valid_not_on_or_after: 'minutes=5',
      });
    }
  });

  // The guide: assertions fresh within five minutes, two minutes of clock skew.
  // authentik's assertions are valid five minutes from their issue time.
  for (const [seconds, works] of [
    [90, true],
    [-90, true],
    [-240, true],
    [240, false],
    [-420, false],
  ])
    it(`${works ? 'signs in' : 'refuses'} with authentik's clock ${seconds > 0 ? 'ahead' : 'behind'} by ${Math.abs(seconds)} seconds`, async () => {
      world.authentik.setClockOffset(seconds);
      try {
        const tried = await attempt(AUTHENTIK, atAuthentik('ada'));
        record(`authentik clock ${seconds > 0 ? '+' : ''}${seconds}s (SAML)`, {
          landed: tried.landed,
          sameAccount: tried.user?.id === adaId,
        });
        assert.equal(
          tried.landed.signedIn,
          works,
          JSON.stringify(tried.landed),
        );
        if (works) assert.equal(tried.user.id, adaId);
      } finally {
        world.authentik.setClockOffset(0);
      }
    });
});
