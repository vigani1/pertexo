import assert from 'node:assert/strict';
import { PUBLIC_HOSTS } from '../../support/overlay.mjs';
import { docker, mustDocker, waitFor } from '../../support/process.mjs';
import { asksForSignIn } from './browser.mjs';
import { IDP_HOSTS, NETWORK } from './identity-network.mjs';

// Keycloak, configured through its admin REST API the way an administrator's
// automation does. One realm per organization; OIDC and SAML clients in each.
const KEYCLOAK =
  'quay.io/keycloak/keycloak:26.8.1@sha256:3f3c5f8e03c614774b4bd9173b88391fefa4153bfc010d8012d59ad825377332';
const CONTAINER = 'pertexo-sim-keycloak';
export const KEYCLOAK_UPSTREAM = `${CONTAINER}:8080`;
const ADMIN = { username: 'sim-admin', password: 'sim-admin-password-1' };
const origin = `https://${IDP_HOSTS.keycloak}`;
export const OIDC_CALLBACK = `https://${PUBLIC_HOSTS.app}/v1/auth/federation/oidc/callback`;

export async function startKeycloak() {
  await docker(['rm', '--force', CONTAINER]);
  await mustDocker([
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--network',
    NETWORK.name,
    '--env',
    `KC_BOOTSTRAP_ADMIN_USERNAME=${ADMIN.username}`,
    '--env',
    `KC_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN.password}`,
    '--env',
    `KC_HOSTNAME=${origin}`,
    '--env',
    'KC_PROXY_HEADERS=xforwarded',
    '--env',
    'KC_HTTP_ENABLED=true',
    KEYCLOAK,
    'start-dev',
  ]);
}

export const stopKeycloak = () => docker(['rm', '--force', CONTAINER]);
export const keycloakLogs = () =>
  docker(['logs', '--tail', '200', CONTAINER]).then(
    (result) => result.stdout + result.stderr,
  );

/** An admin session against the running Keycloak, through the edge. */
export async function keycloakAdmin(network) {
  await waitFor(
    async () =>
      (
        await network
          .request(`${origin}/realms/master/.well-known/openid-configuration`)
          .catch(() => ({ status: 0 }))
      ).status === 200,
    {
      what: 'Keycloak to serve its master realm',
      timeout: 240_000,
      every: 3_000,
    },
  );
  let token;
  const signIn = async () => {
    const response = await network.request(
      `${origin}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        form: {
          grant_type: 'password',
          client_id: 'admin-cli',
          username: ADMIN.username,
          password: ADMIN.password,
        },
      },
    );
    assert.equal(response.status, 200, response.text);
    token = response.json.access_token;
  };
  await signIn();
  const call = async (method, path, body) => {
    const send = () =>
      network.request(`${origin}/admin${path}`, {
        method,
        body,
        headers: { authorization: `Bearer ${token}` },
      });
    let response = await send();
    // Admin tokens live a minute; a scenario can outlast one.
    if (response.status === 401) {
      await signIn();
      response = await send();
    }
    if (response.status >= 300)
      throw new Error(
        `Keycloak ${method} ${path}: ${response.status} ${response.text}`,
      );
    return response;
  };
  const admin = {
    call,
    /** A realm for one organization, with people who can sign in by password. */
    createRealm: async (realm) => {
      await call('POST', '/realms', {
        realm,
        enabled: true,
        // Each person types their password once per scenario; no lockouts.
        bruteForceProtected: false,
      });
      return realmAdmin(realm);
    },
  };
  const realmAdmin = (realm) => {
    const base = `/realms/${realm}`;
    const issuer = `${origin}/realms/${realm}`;
    const userId = async (username) => {
      const found = await call(
        'GET',
        `${base}/users?exact=true&username=${encodeURIComponent(username)}`,
      );
      assert.equal(found.json.length, 1, `one user named ${username}`);
      return found.json[0].id;
    };
    return {
      realm,
      issuer,
      samlEntityId: issuer,
      samlSignInUrl: `${issuer}/protocol/saml`,
      createUser: async ({
        username,
        email,
        firstName,
        lastName = 'Person',
        password,
        emailVerified = true,
      }) => {
        await call('POST', `${base}/users`, {
          username,
          email,
          firstName,
          lastName,
          emailVerified,
          enabled: true,
          credentials: [
            { type: 'password', value: password, temporary: false },
          ],
        });
        return userId(username);
      },
      updateUser: async (username, changes) => {
        const id = await userId(username);
        const current = await call('GET', `${base}/users/${id}`);
        await call('PUT', `${base}/users/${id}`, {
          ...current.json,
          ...changes,
        });
      },
      /** Ends every Keycloak session of the realm's users, as an admin's "sign out all". */
      signOutEveryone: () => call('POST', `${base}/logout-all`),
      createOidcClient: async ({ clientId, secret }) => {
        await call('POST', `${base}/clients`, {
          clientId,
          secret,
          protocol: 'openid-connect',
          publicClient: false,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: false,
          redirectUris: [OIDC_CALLBACK],
          attributes: { 'pkce.code.challenge.method': 'S256' },
        });
      },
      /**
       * A SAML client made from Pertexo's SP metadata, as the setup guide says,
       * then set to what the guide requires. `signing` chooses what Keycloak signs.
       */
      createSamlClient: async (
        metadataXml,
        { signDocument = true, signAssertion = true } = {},
      ) => {
        const described = await call(
          'POST',
          `${base}/client-description-converter`,
          metadataXml,
        );
        const client = described.json;
        const acs =
          client.attributes?.saml_assertion_consumer_url_post ??
          client.redirectUris?.[0];
        await call('POST', `${base}/clients`, {
          ...client,
          redirectUris: [acs],
          attributes: {
            ...client.attributes,
            'saml.server.signature': String(signDocument),
            'saml.assertion.signature': String(signAssertion),
            'saml.client.signature': 'false',
            'saml.force.post.binding': 'true',
            'saml.authnstatement': 'true',
            'saml.signature.algorithm': 'RSA_SHA256',
            saml_force_name_id_format: 'true',
            saml_name_id_format: 'persistent',
          },
          protocolMappers: [
            samlProperty('email', 'email'),
            samlProperty('name', 'firstName'),
          ],
        });
        return client.clientId;
      },
      updateSamlClient: async (clientId, attributes) => {
        const found = await call(
          'GET',
          `${base}/clients?clientId=${encodeURIComponent(clientId)}`,
        );
        const client = found.json[0];
        await call('PUT', `${base}/clients/${client.id}`, {
          ...client,
          attributes: { ...client.attributes, ...attributes },
        });
      },
      /** The certificate of the realm's active signing key, as Realm settings → Keys shows it. */
      samlCertificates: async () => {
        const keys = await call('GET', `${base}/keys`);
        return keys.json.keys
          .filter(
            (key) =>
              key.algorithm === 'RS256' &&
              key.status === 'ACTIVE' &&
              key.use === 'SIG',
          )
          .map((key) => pem(key.certificate));
      },
      /**
       * Rotates the realm's signing key the way Keycloak's guide does: a new
       * generated key with a higher priority, then the old one passive.
       */
      rotateSigningKey: async () => {
        const realmInfo = await call('GET', base);
        const keys = await call('GET', `${base}/keys`);
        const previous = keys.json.keys
          .filter((key) => key.algorithm === 'RS256' && key.status === 'ACTIVE')
          .map((key) => key.providerId);
        await call('POST', `${base}/components`, {
          name: `rotated-${Date.now()}`,
          providerId: 'rsa-generated',
          providerType: 'org.keycloak.keys.KeyProvider',
          parentId: realmInfo.json.id,
          config: {
            priority: [String(1000 + (Date.now() % 1000))],
            keySize: ['2048'],
            algorithm: ['RS256'],
            active: ['true'],
            enabled: ['true'],
          },
        });
        for (const id of previous) {
          const component = await call('GET', `${base}/components/${id}`);
          await call('PUT', `${base}/components/${id}`, {
            ...component.json,
            config: { ...component.json.config, active: ['false'] },
          });
        }
      },
    };
  };
  return admin;
}

const samlProperty = (attribute, property) => ({
  name: attribute,
  protocol: 'saml',
  protocolMapper: 'saml-user-property-mapper',
  config: {
    'user.attribute': property,
    'attribute.name': attribute,
    'attribute.nameformat': 'Basic',
    'friendly.name': attribute,
  },
});

const pem = (base64) =>
  `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`;

/**
 * Signs in on Keycloak's login page; does nothing when Keycloak still has a
 * session and sends the browser straight back.
 */
export async function signInAtKeycloak(page, { username, password }) {
  const field = page.locator('#username');
  if (!(await asksForSignIn(page, field))) return;
  await field.fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
}
