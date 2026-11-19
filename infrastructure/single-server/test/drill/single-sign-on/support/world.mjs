import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '../../support/client.mjs';
import { docker } from '../../support/process.mjs';
import { createWorkspace } from '../../support/product.mjs';
import { createOwner } from '../../support/public-server.mjs';
import {
  configure,
  createServer,
  destroyServer,
} from '../../support/server.mjs';
import {
  AUTHENTIK_UPSTREAM,
  authentikAdmin,
  authentikLogs,
  startAuthentik,
  stopAuthentik,
} from './authentik.mjs';
import { APP, launchBrowser } from './browser.mjs';
import {
  IDP_HOSTS,
  NETWORK,
  closeIdentityNetwork,
  openIdentityNetwork,
  overlayIdentityCompose,
} from './identity-network.mjs';
import {
  KEYCLOAK_UPSTREAM,
  keycloakAdmin,
  keycloakLogs,
  startKeycloak,
  stopKeycloak,
} from './keycloak.mjs';

// Everything one scenario file needs: the identity providers on their network,
// the production server deployed by deploy.sh, its first owner, and a browser.
export async function openWorld() {
  const network = await openIdentityNetwork();
  await startKeycloak();
  const server = await createServer({ compose: overlayIdentityCompose });
  await configure(server);
  // The server trusts the providers' authority the way it trusts public CAs.
  await server.mustExec('cat >> drill-tls/ca.crt', {
    input: network.authority,
  });
  const authentik = await startAuthentik([server.ca, network.authority]);
  await network.startEdge({
    [IDP_HOSTS.keycloak]: KEYCLOAK_UPSTREAM,
    [IDP_HOSTS.authentik]: AUTHENTIK_UPSTREAM,
  });
  const deployed = await server.script('deploy.sh', [server.releases.first]);
  assert.equal(deployed.status, 0, deployed.stdout + deployed.stderr);
  const newClient = () =>
    createClient({
      origin: APP,
      connect: { host: NETWORK.server, port: 443 },
      ca: server.ca,
    });
  const owner = {
    email: `owner-${randomUUID().slice(0, 8)}@drill.test`,
    password: 'correct-horse-battery-staple-5',
    name: 'Directory Owner',
  };
  const client = newClient();
  await createOwner(server, client, owner);
  const [keycloak, authentikApi, browser] = await Promise.all([
    keycloakAdmin(network),
    authentikAdmin(network, authentik),
    launchBrowser({ authority: server.ca }),
  ]);
  return {
    network,
    server,
    owner,
    client,
    newClient,
    keycloak,
    authentik: { ...authentikApi, setClockOffset: authentik.setClockOffset },
    browser,
    createWorkspace: () => createWorkspace(client),
    /** The API's log lines that name why a sign-in was refused. */
    refusals: async () => {
      const result = await docker(['logs', await server.containerOf('api')]);
      return (result.stdout + result.stderr)
        .split('\n')
        .filter((line) => /Authentication (refused|failed)/u.test(line))
        .map((line) => /Authentication \w+: \S+ \S+/u.exec(line)?.[0] ?? line);
    },
  };
}

export async function closeWorld(world) {
  await world?.browser?.close();
  if (process.env.DRILL_KEEP === 'true') return;
  await destroyServer();
  await stopKeycloak();
  await stopAuthentik();
  await closeIdentityNetwork();
}

/** Provider logs for a failing run, so a reader sees both sides. */
export const providerLogs = async () =>
  `${await keycloakLogs()}\n${await authentikLogs()}`;
