import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docker, mustDocker, waitFor } from '../../support/process.mjs';
import { asksForSignIn } from './browser.mjs';
import { IDP_HOSTS, NETWORK } from './identity-network.mjs';
import { OIDC_CALLBACK } from './keycloak.mjs';

// authentik, the identity provider self-hosters run most besides Keycloak, set
// up through its API the way its Terraform provider does. Its server reads the
// time through libfaketime, so a scenario can set its clock a few minutes off
// the way a drifting host's clock is.
const AUTHENTIK =
  'ghcr.io/goauthentik/server:2026.8.5@sha256:602227a86455d6772e3d16b7d852713c4f864f40df5df894abd1285bb53979a5';
const POSTGRES =
  'postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';
const IMAGE = 'pertexo-sim-authentik:local';
const names = {
  database: 'pertexo-sim-authentik-db',
  server: 'pertexo-sim-authentik',
  worker: 'pertexo-sim-authentik-worker',
};
export const AUTHENTIK_UPSTREAM = `${names.server}:9000`;
const origin = `https://${IDP_HOSTS.authentik}`;
const FAKETIME = '/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1';

/** Starts authentik trusting `authorities` (PEM), e.g. the app's own CA for SCIM. */
export async function startAuthentik(authorities) {
  await stopAuthentik();
  await mustDocker(['build', '--quiet', '--tag', IMAGE, '-'], {
    input: `FROM ${AUTHENTIK}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime && rm -rf /var/lib/apt/lists/*
USER 1000
`,
  });
  const shared = mkdtempSync(join(tmpdir(), 'pertexo-authentik-'));
  chmodSync(shared, 0o755);
  writeFileSync(join(shared, 'authorities.pem'), authorities.join('\n'));
  writeFileSync(join(shared, 'clock'), '+0\n');
  chmodSync(join(shared, 'clock'), 0o644);
  const secrets = {
    database: randomBytes(16).toString('hex'),
    key: randomBytes(32).toString('hex'),
    token: randomBytes(24).toString('hex'),
    password: randomBytes(12).toString('hex'),
  };
  await mustDocker([
    'run',
    '--detach',
    '--name',
    names.database,
    '--network',
    NETWORK.name,
    '--env',
    'POSTGRES_USER=authentik',
    '--env',
    'POSTGRES_DB=authentik',
    '--env',
    `POSTGRES_PASSWORD=${secrets.database}`,
    POSTGRES,
  ]);
  await waitFor(
    async () =>
      (
        await docker([
          'exec',
          names.database,
          'pg_isready',
          '-U',
          'authentik',
          '-d',
          'authentik',
        ])
      ).status === 0,
    { what: "authentik's database", timeout: 60_000, every: 1_000 },
  );
  const environment = [
    `AUTHENTIK_SECRET_KEY=${secrets.key}`,
    `AUTHENTIK_POSTGRESQL__HOST=${names.database}`,
    'AUTHENTIK_POSTGRESQL__USER=authentik',
    'AUTHENTIK_POSTGRESQL__NAME=authentik',
    `AUTHENTIK_POSTGRESQL__PASSWORD=${secrets.database}`,
    `AUTHENTIK_BOOTSTRAP_PASSWORD=${secrets.password}`,
    `AUTHENTIK_BOOTSTRAP_TOKEN=${secrets.token}`,
    `AUTHENTIK_BOOTSTRAP_EMAIL=admin@${IDP_HOSTS.authentik}`,
    // The edge is on a public range, which authentik doesn't trust by default.
    `AUTHENTIK_LISTEN__TRUSTED_PROXY_CIDRS=${NETWORK.subnet}`,
    'AUTHENTIK_ERROR_REPORTING__ENABLED=false',
    'AUTHENTIK_DISABLE_UPDATE_CHECK=true',
    'AUTHENTIK_DISABLE_STARTUP_ANALYTICS=true',
    'REQUESTS_CA_BUNDLE=/sim/authorities.pem',
    'SSL_CERT_FILE=/sim/authorities.pem',
  ].flatMap((value) => ['--env', value]);
  const start = (name, role, extra = []) =>
    mustDocker([
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      NETWORK.name,
      '--dns',
      NETWORK.dns,
      '--volume',
      `${shared}:/sim:ro`,
      ...environment,
      ...extra,
      IMAGE,
      role,
    ]);
  await start(names.server, 'server', [
    '--env',
    `LD_PRELOAD=${FAKETIME}`,
    '--env',
    'FAKETIME_TIMESTAMP_FILE=/sim/clock',
    '--env',
    'FAKETIME_NO_CACHE=1',
    '--env',
    'FAKETIME_DONT_FAKE_MONOTONIC=1',
  ]);
  await start(names.worker, 'worker');
  return {
    token: secrets.token,
    /** Sets how far the server's clock is off, in seconds (negative: behind). */
    setClockOffset: (seconds) =>
      writeFileSync(
        join(shared, 'clock'),
        `${seconds >= 0 ? '+' : ''}${seconds}\n`,
      ),
  };
}

export const stopAuthentik = () =>
  docker(['rm', '--force', '--volumes', ...Object.values(names)]);
export const authentikLogs = async () => {
  let text = '';
  for (const name of [names.server, names.worker]) {
    const result = await docker(['logs', '--tail', '150', name]);
    text += `--- ${name}\n${result.stdout}${result.stderr}\n`;
  }
  return text;
};

/** An API session as the bootstrap token, through the edge. */
export async function authentikAdmin(network, { token }) {
  const call = async (method, path, body) => {
    const response = await network.request(`${origin}/api/v3${path}`, {
      method,
      body,
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status >= 300)
      throw new Error(
        `authentik ${method} ${path}: ${response.status} ${response.text.slice(0, 2000)}`,
      );
    return response.json;
  };
  const one = async (path) => {
    const page = await call('GET', path);
    assert.equal(page.results.length, 1, `one result for ${path}`);
    return page.results[0];
  };
  // The worker applies the default flows and mappings a little after start.
  const flows = await waitFor(
    async () => {
      const ready = await network
        .request(`${origin}/-/health/ready/`)
        .catch(() => ({ status: 0 }));
      if (ready.status !== 200) return undefined;
      const found = await call(
        'GET',
        '/flows/instances/?slug=default-provider-authorization-implicit-consent',
      ).catch(() => undefined);
      const invalidation = await call(
        'GET',
        '/flows/instances/?slug=default-provider-invalidation-flow',
      ).catch(() => undefined);
      return found?.results.length === 1 && invalidation?.results.length === 1
        ? {
            authorization: found.results[0].pk,
            invalidation: invalidation.results[0].pk,
          }
        : undefined;
    },
    { what: 'authentik and its default flows', timeout: 360_000, every: 5_000 },
  );
  const scope = (name) =>
    one(
      `/propertymappings/provider/scope/?managed=goauthentik.io/providers/oauth2/scope-${name}`,
    ).then((mapping) => mapping.pk);
  const signing = await call('POST', '/crypto/certificatekeypairs/generate/', {
    common_name: 'pertexo-sim-signing',
    validity_days: 30,
  });
  const certificate = async (keypair) =>
    (
      await call(
        'GET',
        `/crypto/certificatekeypairs/${keypair}/view_certificate/`,
      )
    ).data;
  return {
    call,
    signingCertificate: () => certificate(signing.pk),
    /**
     * An OIDC application. `emailVerified` false keeps authentik's default
     * email mapping, which says every address is unverified.
     */
    createOidcApplication: async ({
      slug,
      clientId,
      secret,
      emailVerified,
    }) => {
      const email = emailVerified
        ? (
            await call('POST', '/propertymappings/provider/scope/', {
              name: `${slug}: verified email`,
              scope_name: 'email',
              expression:
                'return {"email": request.user.email, "email_verified": True}',
            })
          ).pk
        : await scope('email');
      const provider = await call('POST', '/providers/oauth2/', {
        name: `${slug} OIDC`,
        authorization_flow: flows.authorization,
        invalidation_flow: flows.invalidation,
        client_type: 'confidential',
        grant_types: ['authorization_code'],
        client_id: clientId,
        client_secret: secret,
        redirect_uris: [{ matching_mode: 'strict', url: OIDC_CALLBACK }],
        property_mappings: [
          await scope('openid'),
          email,
          await scope('profile'),
        ],
        signing_key: signing.pk,
        sub_mode: 'hashed_user_id',
        issuer_mode: 'per_provider',
      });
      const application = await call('POST', '/core/applications/', {
        name: slug,
        slug,
        provider: provider.pk,
      });
      return {
        issuer: `${origin}/application/o/${slug}/`,
        providerId: provider.pk,
        application: application.slug,
      };
    },
    /** A SAML application for one Pertexo organization's SP. */
    createSamlApplication: async ({
      slug,
      entityId,
      acsUrl,
      audience = entityId,
    }) => {
      const mapping = async (managed) =>
        (
          await one(
            `/propertymappings/provider/saml/?managed=goauthentik.io/providers/saml/${managed}`,
          )
        ).pk;
      const issuer = `${origin}/saml/${slug}`;
      const provider = await call('POST', '/providers/saml/', {
        name: `${slug} SAML`,
        authorization_flow: flows.authorization,
        invalidation_flow: flows.invalidation,
        acs_url: acsUrl,
        audience,
        issuer_override: issuer,
        sp_binding: 'post',
        signing_kp: signing.pk,
        sign_assertion: true,
        sign_response: true,
        signature_algorithm:
          'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        digest_algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        default_name_id_policy:
          'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
        property_mappings: [await mapping('email'), await mapping('name')],
      });
      await call('POST', '/core/applications/', {
        name: slug,
        slug,
        provider: provider.pk,
      });
      return {
        issuer,
        signInUrl: `${origin}/application/saml/${slug}/sso/binding/redirect/`,
        providerId: provider.pk,
        emailAttribute:
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        nameAttribute:
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      };
    },
    updateSamlProvider: (id, changes) =>
      call('PATCH', `/providers/saml/${id}/`, changes),
    /** A SCIM provider pushing to Pertexo, attached to `application`. */
    createScimProvider: async ({ url, token: bearer, application, groups }) => {
      const scimMapping = async (kind) =>
        (
          await one(
            `/propertymappings/provider/scim/?managed=goauthentik.io/providers/scim/${kind}`,
          )
        ).pk;
      const provider = await call('POST', '/providers/scim/', {
        name: 'Pertexo directory',
        url,
        token: bearer,
        auth_mode: 'token',
        verify_certificates: true,
        exclude_users_service_account: true,
        group_filters: groups,
        property_mappings: [await scimMapping('user')],
        property_mappings_group: [await scimMapping('group')],
      });
      await call('PATCH', `/core/applications/${application}/`, {
        backchannel_providers: [provider.pk],
      });
      return provider.pk;
    },
    /** What the provider's sync page says: its last runs and their messages. */
    syncStatus: async (provider) => {
      const status = await call(
        'GET',
        `/providers/scim/${provider}/sync/status/`,
      );
      // The task list keeps each SCIM task's own log lines and retries.
      const tasks = await call('GET', '/tasks/tasks/?page_size=50');
      return {
        status,
        tasks: tasks.results
          .filter((task) => /scim/u.test(task.actor_name))
          .map((task) => ({
            actor: task.actor_name,
            state: task.state,
            retries: task.retries,
            logs: [...(task.previous_logs ?? []), ...(task.logs ?? [])]
              .map(
                (entry) =>
                  `${entry.log_level}: ${entry.event} ${JSON.stringify(entry.attributes ?? {})}`,
              )
              .slice(-8),
          })),
      };
    },
    /** Pushes one user or group now, as the provider's "Sync" button does. */
    syncNow: (provider, model, id) =>
      call('POST', `/providers/scim/${provider}/sync/object/`, {
        sync_object_model: model,
        sync_object_id: String(id),
      }),
    createUser: async ({ username, name, email, password, groups = [] }) => {
      const user = await call('POST', '/core/users/', {
        username,
        name,
        email,
        is_active: true,
        path: 'users',
        type: 'internal',
        groups,
      });
      await call('POST', `/core/users/${user.pk}/set_password/`, { password });
      return user;
    },
    updateUser: (pk, changes) => call('PATCH', `/core/users/${pk}/`, changes),
    deleteUser: (pk) => call('DELETE', `/core/users/${pk}/`),
    createGroup: (name) => call('POST', '/core/groups/', { name }),
    setGroupMembers: (group, users) =>
      call('PATCH', `/core/groups/${group}/`, { users }),
  };
}

/**
 * Signs in on authentik's flow pages; does nothing when authentik still has a
 * session and sends the browser straight back.
 */
export async function signInAtAuthentik(page, { username, password }) {
  const user = page.locator('input[name="uidField"]:visible');
  if (!(await asksForSignIn(page, user))) return;
  await user.fill(username);
  const submit = page.getByRole('button', { name: /log in|continue/iu });
  // The first page also shows a password field for password managers, but
  // only the next stage takes the password.
  await submit.click();
  await page.getByText('Not you?').waitFor();
  await page.locator('input[name="password"]:visible').fill(password);
  await submit.click();
}
