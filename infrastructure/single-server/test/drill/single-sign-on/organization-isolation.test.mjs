import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createReport } from '../support/simulation-report.mjs';
import {
  APP,
  appGet,
  currentUser,
  openPerson,
  signInWithOrganization,
  tamperNextSamlResponse,
  workspacesOf,
  limitedSignIns,
} from './support/browser.mjs';
import { signInAtKeycloak } from './support/keycloak.mjs';
import {
  addOidcProvider,
  addSamlProvider,
  createOrganization,
  members,
  readSettings,
  samlServiceProvider,
} from './support/organization.mjs';
import { replaceEmail, wrapForgedBefore } from './support/saml-response.mjs';
import { closeWorld, openWorld, providerLogs } from './support/world.mjs';

// Two organizations on one install, each with its own Keycloak realm. Whoever
// controls organization A's provider must never reach organization B: not with
// B's addresses, not with A's signed responses, not by naming B's domain.
// Rerun on a Linux machine with Docker:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/single-sign-on/organization-isolation.test.mjs
const A = { domain: 'alpha-corp.test', realm: 'alpha' };
const B = { domain: 'beta-corp.test', realm: 'beta' };
const password = 'provider-password-7';
const record = createReport();

describe('organizations stay apart', () => {
  let world;

  const setUpOrganization = async (organization, name) => {
    organization.workspaceId = await world.createWorkspace();
    await createOrganization(world.client, world.network, {
      workspaceId: organization.workspaceId,
      name,
      domains: [organization.domain],
    });
    organization.keycloak = await world.keycloak.createRealm(
      organization.realm,
    );
    await organization.keycloak.createOidcClient({
      clientId: 'pertexo',
      secret: `${organization.realm}-secret`,
    });
    organization.oidc = `${name} OIDC`;
    organization.oidcId = await addOidcProvider(
      world.client,
      organization.workspaceId,
      {
        name: organization.oidc,
        issuer: organization.keycloak.issuer,
        clientId: 'pertexo',
        secret: `${organization.realm}-secret`,
      },
    );
    const sp = await samlServiceProvider(
      world.client,
      organization.workspaceId,
    );
    await organization.keycloak.createSamlClient(sp.xml);
    organization.saml = `${name} SAML`;
    await addSamlProvider(world.client, organization.workspaceId, {
      name: organization.saml,
      issuer: organization.keycloak.samlEntityId,
      signInUrl: organization.keycloak.samlSignInUrl,
      certificates: await organization.keycloak.samlCertificates(),
    });
  };

  before(async () => {
    world = await openWorld();
    await setUpOrganization(A, 'Alpha');
    await setUpOrganization(B, 'Beta');
    const user = (realm, username, email) =>
      realm.keycloak.createUser({
        username,
        email,
        firstName: username,
        password,
      });
    await user(A, 'alice', `alice@${A.domain}`);
    await user(A, 'eve', `eve@${A.domain}`);
    // A's administrator gives someone B's address.
    await user(A, 'mallory', `bob@${B.domain}`);
    await user(B, 'bob', `bob@${B.domain}`);
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

  const at = (username) => (page) =>
    signInAtKeycloak(page, { username, password });
  const attempt = async (organization, provider, username, prepare) => {
    const person = await openPerson(world.browser);
    try {
      const prepared = prepare?.(person.page);
      const landed = await signInWithOrganization(person.page, {
        domain: organization.domain,
        provider,
        atProvider: at(username),
      });
      await prepared;
      const me = await currentUser(person.page);
      const workspaces = await workspacesOf(person.page);
      return {
        landed,
        user: me.user,
        status: me.status,
        workspaces: workspaces.items.map(
          (item) => item.id ?? item.workspace?.id,
        ),
        callbacks: person.callbacks,
      };
    } finally {
      await person.close();
    }
  };
  const emailsIn = async (organization) =>
    (await members(world.client, organization.workspaceId)).map(
      (member) => member.email,
    );
  let bobId;
  let aliceResponse;

  it("signs B's person into B's workspace only", async () => {
    const bob = await attempt(B, B.oidc, 'bob');
    bobId = bob.user?.id;
    record("B's person", { landed: bob.landed, workspaces: bob.workspaces });
    assert.equal(bob.landed.signedIn, true, JSON.stringify(bob.landed));
    assert.ok(bob.workspaces.includes(B.workspaceId));
    assert.ok(!bob.workspaces.includes(A.workspaceId));
    const alice = await attempt(A, A.saml, 'alice');
    aliceResponse = alice.callbacks.find((entry) => entry.protocol === 'saml');
    assert.equal(alice.landed.signedIn, true, JSON.stringify(alice.landed));
    assert.ok(!alice.workspaces.includes(B.workspaceId));
  });

  it("offers each domain only its own organization's providers", async () => {
    const discover = async (domain) => {
      const person = await openPerson(world.browser);
      const body = await appGet(
        person.page,
        `/v1/auth/federation/discover?domain=${domain}`,
      ).then((response) => response.json);
      await person.close();
      return body.providers.map((provider) => provider.name).sort();
    };
    const found = { a: await discover(A.domain), b: await discover(B.domain) };
    record('discovery', found);
    assert.deepEqual(found.a, [A.oidc, A.saml].sort());
    assert.deepEqual(found.b, [B.oidc, B.saml].sort());
  });

  it("refuses A's provider asserting B's address, through OIDC and SAML", async () => {
    const before = await emailsIn(B);
    const oidc = await attempt(A, A.oidc, 'mallory');
    const saml = await attempt(A, A.saml, 'mallory');
    const after = await emailsIn(B);
    record("A asserts B's address", {
      oidc: { landed: oidc.landed, status: oidc.status },
      saml: { landed: saml.landed, status: saml.status },
      bMembersBefore: before.length,
      bMembersAfter: after.length,
    });
    for (const tried of [oidc, saml]) {
      assert.equal(tried.landed.signedIn, false, JSON.stringify(tried.landed));
      assert.equal(tried.status, 401);
    }
    assert.deepEqual(after, before);
  });

  it("refuses starting A's provider for B's domain", async () => {
    const person = await openPerson(world.browser);
    await person.page.goto(`${APP}/login`);
    const started = await person.page.evaluate(
      async (body) => {
        const response = await fetch('/v1/auth/federation/oidc/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
      },
      { providerId: A.oidcId, domain: B.domain },
    );
    record("A's provider for B's domain", started);
    await person.close();
    assert.ok(started.status >= 400, JSON.stringify(started));
  });

  it("refuses A's signed responses edited to name B's person", async () => {
    const results = {};
    for (const [name, transform] of [
      ['email edited', replaceEmail],
      ['forged assertion wrapped', wrapForgedBefore],
    ]) {
      const tried = await attempt(A, A.saml, 'eve', (page) =>
        tamperNextSamlResponse(page, (body) =>
          transform(body, `bob@${B.domain}`),
        ),
      );
      results[name] = { landed: tried.landed, status: tried.status };
      assert.equal(tried.landed.signedIn, false, JSON.stringify(tried.landed));
      assert.equal(tried.status, 401);
    }
    record("A's response edited for B's person", results);
  });

  it("refuses A's genuine response delivered into B's sign-in", async () => {
    const tried = await attempt(B, B.saml, 'bob', (page) =>
      tamperNextSamlResponse(page, (body) => {
        const fields = new URLSearchParams(body);
        fields.set(
          'SAMLResponse',
          new URLSearchParams(aliceResponse.body).get('SAMLResponse'),
        );
        return fields.toString();
      }),
    );
    record("A's response in B's journey", {
      landed: tried.landed,
      status: tried.status,
    });
    assert.equal(tried.landed.signedIn, false, JSON.stringify(tried.landed));
    assert.equal(tried.status, 401);
  });

  it("left B's workspace with only B's people, and bob's account untouched", async () => {
    const emails = await emailsIn(B);
    const bob = await attempt(B, B.oidc, 'bob');
    const settings = await readSettings(world.client, B.workspaceId);
    record("B's workspace afterwards", { emails, bobStillSignsIn: bob.landed });
    assert.deepEqual(
      emails.filter((email) => !email.endsWith('@drill.test')),
      [`bob@${B.domain}`],
    );
    assert.equal(bob.user.id, bobId);
    assert.equal(settings.organization.domains[0].domain, B.domain);
  });
});
