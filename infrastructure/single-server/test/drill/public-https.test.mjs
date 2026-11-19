import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { PUBLIC_HOSTS } from './support/overlay.mjs';
import { waitFor } from './support/process.mjs';
import { createWorkspace } from './support/product.mjs';
import {
  INTERNET,
  closeInternet,
  openInternet,
} from './support/public-internet.mjs';
import {
  createOwner,
  createPublicServer,
  linksIn,
  publicClient,
  sql,
} from './support/public-server.mjs';
import { destroyServer, joinPrivateNetwork } from './support/server.mjs';
import { createReport, tail } from './support/simulation-report.mjs';

// A self-hoster's first day, on a simulated public internet: real DNS names,
// certificates from an ACME authority the production way, and visitors who
// arrive from outside the server. Follows the runbook's order. Rerun on a Linux
// machine with Docker and sudo:
//   node infrastructure/single-server/test/drill/build-images.mjs
//   node --test infrastructure/single-server/test/drill/public-https.test.mjs

const app = `https://${PUBLIC_HOSTS.app}`;
const person = {
  email: `owner-${randomUUID().slice(0, 8)}@drill.test`,
  password: 'correct-horse-battery-staple-4',
  name: 'Server Owner',
};
// Short enough to watch Caddy renew within a simulation.
const CERTIFICATE_SECONDS = 240;
const record = createReport();

describe('a self-hosted server on the public internet', () => {
  let internet;
  let server;
  let client;
  let firstDeploy;

  before(async () => {
    internet = await openInternet({ certificateSeconds: CERTIFICATE_SECONDS });
    server = await createPublicServer(internet);
    client = publicClient(internet);
  });
  after(async () => {
    if (process.env.DRILL_KEEP === 'true') return;
    await destroyServer();
    await closeInternet();
  });

  const outside = (input) => internet.request(input);
  const serving = async (url = `${app}/v1/auth/ok`) => {
    const response = await outside({ url, timeout: 10_000 });
    return response.status === 200 ? response : undefined;
  };

  it('answers public DNS for both names with the server address', async () => {
    for (const name of [PUBLIC_HOSTS.app, PUBLIC_HOSTS.files])
      assert.equal(await internet.resolve(name), INTERNET.server);
  });

  it('fails a first deploy clearly while the certificate authority is unreachable', async () => {
    await internet.blockAuthority();
    const started = Date.now();
    firstDeploy = await server.script('deploy.sh', [server.releases.first]);
    // What the deploy itself said, without Compose's container progress lines.
    const messages = (firstDeploy.stdout + firstDeploy.stderr)
      .split('\n')
      // Compose and image pulls indent their progress lines; the scripts don't.
      .filter(
        (line) =>
          /^\S/u.test(line) &&
          !/^[0-9a-f]{12}: |^Digest|^Status|^Unable to find|pulling from/iu.test(
            line,
          ),
      )
      .slice(-4);
    const visitor = await outside({ url: `${app}/`, timeout: 10_000 });
    // Nothing is current yet: read the attempted release's logs.
    const proxyLog = (
      await server.composeFor(server.releases.first, [
        'logs',
        '--no-log-prefix',
        'proxy',
      ])
    ).stdout;
    const check = await server.script('check.sh', [], {
      env: { ALERT_DISK_PERCENT: '100' },
    });
    record('authority unreachable at first start', {
      deployStatus: firstDeploy.status,
      deploySeconds: Math.round((Date.now() - started) / 1_000),
      deployStdout: tail(firstDeploy.stdout, 4),
      deployMessages: messages,
      visitorSees: visitor.error ?? visitor.status,
      proxyLogMentions: proxyLog
        .split('\n')
        .filter((line) => /obtain|certificate|acme/iu.test(line))
        .slice(-3),
      checkStatus: check.status,
      checkOutput: tail(check.stdout + check.stderr),
    });
    // A visitor cannot get a page without a certificate, so the deploy can't be healthy.
    assert.notEqual(firstDeploy.status, 0, firstDeploy.stdout);
    assert.doesNotMatch(firstDeploy.stdout, /Healthy release/u);
    assert.ok(visitor.error, JSON.stringify(visitor));
    // The operator is told where to look: the proxy, its certificate.
    assert.match(messages.join('\n'), /certificate|TLS|HTTPS|Caddy/iu);
  });

  // The runbook's answer to that failure: fix the cause, then deploy again.
  it('deploys once the authority is reachable again', async () => {
    await internet.unblockAuthority();
    const started = Date.now();
    const deployed = await server.script('deploy.sh', [server.releases.first]);
    record('authority unreachable at first start', {
      redeployStatus: deployed.status,
      redeploySeconds: Math.round((Date.now() - started) / 1_000),
    });
    assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
    assert.match(deployed.stdout, /Healthy release/u);
    assert.ok(await serving(), 'HTTPS from outside');
    await joinPrivateNetwork();
  });

  it('serves each name with its own certificate from the authority', async () => {
    const certificates = {};
    for (const host of [PUBLIC_HOSTS.app, PUBLIC_HOSTS.files]) {
      const response = await outside({
        url: `https://${host}/`,
        timeout: 10_000,
      });
      assert.ok(response.certificate, JSON.stringify(response));
      certificates[host] = response.certificate;
      assert.match(
        response.certificate.subjectaltname,
        new RegExp(`DNS:${host.replaceAll('.', '\\.')}`, 'u'),
      );
      assert.match(response.certificate.issuer, /Pebble/u);
      const lifetime =
        (Date.parse(response.certificate.validTo) -
          Date.parse(response.certificate.validFrom)) /
        1_000;
      assert.ok(lifetime <= CERTIFICATE_SECONDS + 60, `lifetime ${lifetime}`);
    }
    record('certificates', certificates);
  });

  it('sends plain-HTTP visitors to the same address on HTTPS, and pins HTTPS', async () => {
    const plain = await outside({
      url: `http://${PUBLIC_HOSTS.app}/workflows?tab=all`,
    });
    const secure = await outside({ url: `${app}/` });
    record('redirects', {
      plainStatus: plain.status,
      plainLocation: plain.headers?.location,
      strictTransportSecurity: secure.headers?.['strict-transport-security'],
    });
    assert.ok([301, 308].includes(plain.status), JSON.stringify(plain));
    assert.equal(plain.headers.location, `${app}/workflows?tab=all`);
    assert.match(secure.headers['strict-transport-security'], /max-age=\d+/u);
  });

  it('mails a verification link on the public HTTPS name, and signs in with secure cookies', async () => {
    const { mail, link, signedIn } = await createOwner(server, client, person);
    const links = linksIn(mail);
    const cookies = (signedIn.headers['set-cookie'] ?? []).map((line) => {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim());
      return { name: pair.slice(0, pair.indexOf('=')), attributes };
    });
    record('first account', { links, cookies, from: mail.From });
    for (const url of links) assert.ok(url.startsWith(`${app}/`), url);
    assert.ok(link.startsWith(`${app}/`), link);
    assert.ok(cookies.length > 0);
    for (const cookie of cookies) {
      assert.ok(cookie.attributes.includes('Secure'), JSON.stringify(cookie));
      assert.ok(
        cookie.attributes.some((attribute) =>
          /^SameSite=(Lax|Strict)$/iu.test(attribute),
        ),
        JSON.stringify(cookie),
      );
    }
  });

  it('records the address of a person who signs in from outside, not the proxy', async () => {
    const response = await outside({
      method: 'POST',
      url: `${app}/v1/auth/sign-in/email`,
      headers: { origin: app, 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({ email: person.email, password: person.password }),
      ).toString('base64'),
    });
    assert.equal(response.status, 200, response.text);
    const addresses = (
      await sql(
        server,
        'select ip_address from app.auth_sessions order by created_at desc limit 2',
      )
    ).split('\n');
    record('client address', { sessionAddresses: addresses });
    assert.equal(addresses[0], INTERNET.sender);
  });

  it('gives OAuth2 services the public HTTPS callback, and lands back on it', async () => {
    const workspaceId = await createWorkspace(client);
    const connections = `/v1/workspaces/${workspaceId}/connections`;
    const created = await client.post(connections, {
      providerKey: 'http',
      name: 'Simulated OAuth2 service',
      credential: {
        type: 'oauth2',
        clientSecret: 'simulated-client-secret',
        settings: {
          grantType: 'authorization_code',
          authorizationUrl: 'https://identity.example.org/authorize',
          authorizationParameters: {},
          pkce: 's256',
          tokenUrl: 'https://identity.example.org/token',
          clientId: 'pertexo-simulation',
          scope: 'read',
          clientAuthentication: 'basic',
          tokenParameters: {},
          requestHosts: { mode: 'listed', hosts: ['api.example.org'] },
        },
      },
    });
    assert.ok(created.status < 300, created.text);
    const connectionId = (created.json.connection ?? created.json).id;
    const read = await client.get(`${connections}/${connectionId}`);
    const shown = (read.json.connection ?? read.json).oauth2.redirectUri;
    const started = await client.post(
      `${connections}/${connectionId}/oauth2/authorization`,
    );
    assert.equal(started.status, 200, started.text);
    const consent = new URL(started.json.authorizationUrl);
    const callback = consent.searchParams.get('redirect_uri');
    const binding = (started.headers['set-cookie'] ?? []).map((line) =>
      line.replace(/=[^;]*/u, '=<value>'),
    );
    const returned = await outside({
      url: `${callback}?code=simulated&state=not-the-issued-state`,
    });
    record('OAuth2', {
      shownRedirectUri: shown,
      consentRedirectUri: callback,
      bindingCookie: binding,
      callbackStatus: returned.status,
      callbackLocation: returned.headers?.location,
    });
    assert.equal(shown, `${app}/v1/connections/oauth2/callback`);
    assert.equal(callback, shown);
    for (const cookie of binding) assert.match(cookie, /;\s*Secure/iu);
    assert.ok([302, 303].includes(returned.status), JSON.stringify(returned));
    assert.ok(
      returned.headers.location.startsWith(
        `${app}/connections/oauth2/finished`,
      ),
      returned.headers.location,
    );
  });

  it('renews its certificate before it expires, with no failed visit', async () => {
    const first = (await serving()).certificate;
    const failures = [];
    const renewed = await waitFor(
      async () => {
        const response = await outside({
          url: `${app}/v1/auth/ok`,
          timeout: 10_000,
        });
        if (response.status !== 200)
          failures.push(response.error ?? response.status);
        return (
          response.certificate?.serial !== first.serial && response.certificate
        );
      },
      {
        what: 'a renewed certificate',
        timeout: CERTIFICATE_SECONDS * 2_000,
        every: 5_000,
      },
    );
    record('renewal', {
      first: first.validTo,
      renewed: renewed.validTo,
      failedVisits: failures,
    });
    assert.ok(Date.parse(renewed.validTo) > Date.parse(first.validTo));
    assert.deepEqual(failures, []);
  });
});
