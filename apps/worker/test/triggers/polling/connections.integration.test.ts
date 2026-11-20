import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, onTestFinished } from 'vitest';
import {
  createConnectionStore,
  encodeStoredClientSecret,
  encodeStoredTokens,
} from '@pertexo/core/connections';
import {
  createConnectionEnvelopeEncryption,
  parseAllowedPrivateNetworks,
  type ConnectionEnvelopeEncryptionConfig,
} from '@pertexo/secrets/server';
import { maintenanceConfig } from '../../../../../infrastructure/testing/worker-databases.mjs';
import { testStackSetting } from '../../../../../infrastructure/testing/test-stack.mjs';
import { pollingFixture } from '../../../../../packages/core/test/triggers/polling/polling.fixture.js';
import { createTriggerRuntime } from '../../../src/triggers/trigger.runtime.js';
import { createHttpPollFetcher } from '../../../src/triggers/fetch-http-poll.js';
import { createProviderConnectionRuntime } from '../../../src/providers/connections.runtime.js';
import { json, server } from '../../integrations/support/pagination.js';

const connectionEncryption: ConnectionEnvelopeEncryptionConfig = {
  mode: 'self-managed',
  encryption: {
    previous: [],
    current: {
      version: 'poll-test',
      key: Buffer.alloc(32, 7).toString('base64'),
    },
  },
};

let poll: ReturnType<typeof pollingFixture>;
let connections: ReturnType<typeof createConnectionStore>;

beforeEach(async () => {
  poll = pollingFixture();
  onTestFinished(() => poll.close());
  await poll.initialize();
  connections = createConnectionStore(poll.config);
  onTestFinished(() => connections.close());
});

async function seal(
  connectionId: string,
  secretVersionId: string,
  bytes: Uint8Array,
) {
  const runtime = createConnectionEnvelopeEncryption(connectionEncryption);
  try {
    return await runtime.encryption.seal(bytes, {
      workspaceId: poll.workspaceId,
      connectionId,
      secretVersionId,
    });
  } finally {
    bytes.fill(0);
    runtime.close();
  }
}

async function connect(
  auth:
    | { authType: 'http_headers' }
    | { authType: 'oauth2'; oauth2Settings: unknown },
  bytes: Uint8Array,
) {
  const connectionId = randomUUID();
  const secretVersionId = randomUUID();
  const scope = {
    workspaceId: poll.workspaceId,
    actorId: poll.actorId,
    connectionId,
  };
  await connections.createConnection({
    ...scope,
    ...auth,
    secretVersionId,
    providerKey: 'http',
    name: 'Feed connection',
    sealed: await seal(connectionId, secretVersionId, bytes),
    idempotencyKey: randomUUID(),
    requestHash: 'b'.repeat(64),
  });
  return { scope, secretVersionId };
}

const addressPolicy = {
  allowedPrivateNetworks: parseAllowedPrivateNetworks('127.0.0.1/32'),
};

async function providerConnections() {
  const runtime = await createProviderConnectionRuntime({
    addressPolicy,
    connectionEncryption,
    database: poll.config,
    redisUrl: testStackSetting('REDIS_URL'),
  });
  onTestFinished(() => runtime.close());
  return runtime.connections;
}

it('sends a stored header and checks that its secret is current before requesting the next page', async () => {
  const fetchPoll = createHttpPollFetcher(
    addressPolicy,
    'poll-worker',
    await providerConnections(),
  );
  const credential = new TextEncoder().encode(
    JSON.stringify({
      type: 'http_headers',
      headers: { authorization: 'Bearer header-test-token' },
    }),
  );
  const { scope } = await connect({ authType: 'http_headers' }, credential);
  const requests: { path: string; authorization: string | undefined }[] = [];
  const origin = await server((url, request, response) => {
    requests.push({
      path: url.pathname,
      authorization: request.headers.authorization,
    });
    if (url.pathname !== '/items') {
      json(response, [{ key: 'next' }]);
      return;
    }
    void connections
      .revokeConnection(scope)
      .then(() => {
        response.setHeader('link', '</next>; rel="next"');
        json(response, [{ key: 'partial' }]);
      })
      .catch(() => response.writeHead(500).end());
  });
  const { triggerId } = await poll.publish(
    true,
    `${origin}/items`,
    scope.connectionId,
  );
  await expect(poll.scanner(fetchPoll)()).resolves.toMatchObject({ paused: 1 });
  expect(requests).toEqual([
    { path: '/items', authorization: 'Bearer header-test-token' },
  ]);
  expect(await poll.read(triggerId)).toMatchObject({
    hashes: null,
    leased: false,
    due: true,
    health: 'unhealthy',
    lastErrorCode: 'http.poll_authentication',
  });
  expect(await poll.admitted()).toEqual([]);
});

it('renews a stored OAuth2 credential after a rejected token and uses the replacement on later pages', async () => {
  const requests: { path: string; authorization: string | undefined }[] = [];
  const origin = await server((url, request, response) => {
    requests.push({
      path: url.pathname,
      authorization: request.headers.authorization,
    });
    if (url.pathname === '/token') {
      json(response, {
        access_token: 'renewed-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      return;
    }
    if (request.headers.authorization !== 'Bearer renewed-token') {
      response.writeHead(401).end();
      return;
    }
    if (url.pathname === '/items')
      response.setHeader('link', '</next>; rel="next"');
    json(response, [{ key: url.pathname }]);
  });
  const { scope, secretVersionId } = await connect(
    {
      authType: 'oauth2',
      oauth2Settings: {
        grantType: 'client_credentials',
        tokenUrl: `${origin}/token`,
        clientId: 'poll-client',
        clientAuthentication: 'body',
        scope: '',
        tokenParameters: {},
        requestHosts: { mode: 'listed', hosts: ['127.0.0.1'] },
      },
    },
    encodeStoredClientSecret('poll-client-secret'),
  );
  const tokenId = randomUUID();
  await connections.authorizeOAuth2Connection({
    ...scope,
    secretVersionId,
    issued: {
      id: tokenId,
      sealed: await seal(
        scope.connectionId,
        tokenId,
        encodeStoredTokens({ accessToken: 'rejected-token' }),
      ),
      renewable: true,
      expiresInSeconds: 3600,
    },
  });
  const { triggerId } = await poll.publish(
    true,
    `${origin}/items`,
    scope.connectionId,
  );
  // The real renewal service only invalidates a rejected token after its cooldown.
  await poll.ownerQuery(
    "update app.connection_oauth2_tokens set issued_at = statement_timestamp() - interval '2 hours' where id=$1",
    [tokenId],
  );
  const triggers = await createTriggerRuntime(
    {
      database: poll.config,
      maintenanceDatabase: maintenanceConfig(poll.config),
      httpRequest: addressPolicy,
      providerConnections: await providerConnections(),
      redisUrl: testStackSetting('REDIS_URL'),
      leaseOwner: 'poll-worker',
      leaseDurationSeconds: 30,
      pollIntervalMillis: 250,
      onTimeWindowSeconds: 300,
      batchSize: 1,
    },
    { checkpoints: () => poll.checkpointFactory },
  );
  onTestFinished(() => triggers.close());
  await expect(triggers.checkReadiness()).resolves.toBeUndefined();
  expect(requests).toEqual([
    { path: '/items', authorization: 'Bearer rejected-token' },
    { path: '/token', authorization: undefined },
    { path: '/items', authorization: 'Bearer renewed-token' },
    { path: '/next', authorization: 'Bearer renewed-token' },
  ]);
  expect((await poll.read(triggerId))?.hashes).toHaveLength(2);
  expect(await poll.admitted()).toEqual([]);
});

it('resumes the existing position after repairing the credential and admits only new items', async () => {
  const fetchPoll = createHttpPollFetcher(
    addressPolicy,
    'poll-worker',
    await providerConnections(),
  );
  const header = (token: string) =>
    new TextEncoder().encode(
      JSON.stringify({
        type: 'http_headers',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  const { scope, secretVersionId } = await connect(
    { authType: 'http_headers' },
    header('original'),
  );
  let token = 'original';
  const items = [{ key: 'baseline' }];
  const origin = await server((_url, request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    json(response, items);
  });
  const { triggerId } = await poll.publish(
    true,
    `${origin}/items`,
    scope.connectionId,
  );
  const scan = poll.scanner(fetchPoll);
  await scan();
  const baseline = (await poll.read(triggerId))?.hashes;
  token = 'replacement';
  items.unshift({ key: 'new' });
  await poll.makeDue(triggerId);
  expect(await scan()).toMatchObject({ paused: 1 });

  const replacementId = randomUUID();
  await connections.rotateConnectionSecret({
    ...scope,
    secretVersionId: replacementId,
    expectedCurrentSecretVersionId: secretVersionId,
    sealed: await seal(scope.connectionId, replacementId, header(token)),
    idempotencyKey: randomUUID(),
    requestHash: 'd'.repeat(64),
  });
  const workflowScope = {
    workspaceId: scope.workspaceId,
    actorId: scope.actorId,
    workflowId: poll.workflowId,
  };
  const paused = await poll.controls.readWorkflowSettings(workflowScope);
  expect(paused.pauseEvidence).toEqual({
    kind: 'poll',
    triggerId,
    errorCode: 'http.poll_authentication',
  });
  expect(await scan()).toMatchObject({ claimed: 0 });
  await poll.controls.resumeWorkflow({
    ...workflowScope,
    expectedPauseRevision: paused.pauseRevision,
    idempotencyKey: randomUUID(),
  });
  expect((await poll.read(triggerId))?.hashes).toEqual(baseline);
  expect(await scan()).toMatchObject({ accepted: 1 });
  expect(await poll.admitted()).toEqual([{ item: { key: 'new' }, outbox: 1 }]);
  expect(await poll.read(triggerId)).toMatchObject({
    health: 'healthy',
    lastErrorCode: null,
  });
});
