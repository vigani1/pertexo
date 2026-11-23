import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  connectionResponseSchema,
  nodeDefinitionListResponseSchema,
} from '@pertexo/contracts';
import { catalogRoutes } from '@pertexo/contracts/server';
import {
  loadPlatformRegistry,
  parseCommunityApprovalSet,
} from '@pertexo/node-catalog/server';
import { SecureHttpClient } from '@pertexo/secrets/server';
import { beforeAll, expect, it } from 'vitest';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import { NodeTestingModule } from '../../src/node-testing/node-testing.module.js';
import { FakeIdentityModule } from '../support/identity-module.js';
import { routeHarness } from '../support/route-harness.js';
import {
  nodeTestingDependencies,
  nodeTestingDraft,
  nodeTestingIds,
} from '../node-testing/node-testing.fixture.js';
import { provideHttpClient } from '../../src/platform/connections/http-client.js';
import {
  authenticatedHeaders,
  cleanConnectionsRealNestHTTPStackFixture,
  connectionUrl,
  start,
} from './connection-http-fixture.js';

const providerKey = 'community.example.widgets';
const origin = 'https://widgets.example.com';

beforeAll(async () => {
  const parent = path.resolve(import.meta.dirname, '../../../../.pertexo/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'community-connection-'));
  try {
    const { file, body, version } = fixture();
    await writeFile(path.join(root, file), body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    await loadPlatformRegistry(
      parseCommunityApprovalSet(
        root,
        JSON.stringify([{ file, providerKey, origin, version, sha256 }]),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('creates and manually tests an approved community connection through the HTTP routes', async () => {
  try {
    const requests: { url: string; method: string; authorization?: string }[] =
      [];
    const client = new SecureHttpClient(
      {
        resolve: () =>
          Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      },
      {
        dispatch: (request) => {
          requests.push({
            url: request.url.href,
            method: request.method,
            ...request.headers,
          });
          return Promise.resolve({
            status: 204,
            headers: {},
            body: (async function* () {
              await Promise.resolve();
            })(),
            close() {},
          });
        },
      },
    );
    const { application, connection: testFixture } = await start(
      'owner',
      provideHttpClient(client),
    );
    const catalog = await application.inject({
      method: 'GET',
      url: catalogRoutes.nodeDefinitions.path,
      headers: authenticatedHeaders,
    });
    expect(catalog.statusCode, catalog.payload).toBe(200);
    const { connections } = nodeDefinitionListResponseSchema.parse(
      catalog.json(),
    );
    const form = connections?.find(
      (entry) => entry.providerKey === providerKey,
    );
    if (form === undefined)
      throw new Error('Approved connection form is missing');
    const token = 'test-secret-value';
    const created = await application.inject({
      method: 'POST',
      url: connectionUrl,
      headers: authenticatedHeaders,
      payload: {
        providerKey,
        name: 'Widgets',
        credential: { type: form.authType, token },
      },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const connection = connectionResponseSchema.parse(created.json());
    const read = await application.inject({
      method: 'GET',
      url: `${connectionUrl}/${connection.id}`,
      headers: authenticatedHeaders,
    });
    expect(read.statusCode, read.payload).toBe(200);
    expect(read.json()).toMatchObject({
      id: connection.id,
      providerKey,
      authType: form.authType,
    });
    expect(created.payload + read.payload).not.toContain(token);
    expect(requests).toEqual([]);
    testFixture.encryption.open.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify({ type: form.authType, token })),
    );
    const test = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connection.id}/test`,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'test-community-connection',
      },
      payload: { providerKey },
    });
    expect(test.statusCode, test.payload).toBe(200);
    expect(requests).toEqual([
      {
        url: `${origin}/account`,
        method: 'GET',
        authorization: `Bearer ${token}`,
      },
    ]);
    expect(test.payload).not.toContain(token);
  } finally {
    await cleanConnectionsRealNestHTTPStackFixture();
  }
});

it('requires consent before accepting a preview of an approved write', async () => {
  const definition = platformBrowserNodeDefinitionCatalog().definitions.find(
    (entry) =>
      entry.integration?.providerKey === providerKey &&
      entry.integration.operationKey === 'create',
  );
  if (definition === undefined) throw new Error('Approved write is missing');
  const dependencies = nodeTestingDependencies();
  dependencies.persistence.getDraft.mockResolvedValue(
    nodeTestingDraft({
      graphJson: {
        nodes: [
          {
            id: 'widgets',
            definition: definition.definition,
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
        settings: {},
      },
    }),
  );
  const harness = await routeHarness(
    NodeTestingModule.register(dependencies, { module: FakeIdentityModule }),
  );
  try {
    const { workspaceId, workflowId } = nodeTestingIds;
    const url = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/nodes/widgets/test`;
    const validation = await harness.send('POST', url, {
      body: { mode: 'validate', expectedRevision: 3, sampleInput: {} },
    });
    expect(validation.statusCode, validation.payload).toBe(200);
    expect(validation.json()).toMatchObject({
      valid: true,
      disclosure: {
        sideEffectClass: 'unsafe',
        mayCauseExternalSideEffect: true,
      },
    });

    const run = {
      mode: 'test_execute',
      expectedRevision: 3,
      input: { kind: 'manual', value: {} },
    };
    const headers = { 'idempotency-key': 'community-preview-consent' };
    const unconfirmed = await harness.send('POST', url, {
      headers,
      body: { ...run, acknowledgeSideEffects: false },
    });
    expect(unconfirmed.statusCode, unconfirmed.payload).toBe(400);
    expect(dependencies.persistence.acceptPreview).not.toHaveBeenCalled();
    const confirmed = await harness.send('POST', url, {
      headers,
      body: { ...run, acknowledgeSideEffects: true },
    });
    expect(confirmed.statusCode, confirmed.payload).toBe(202);
    expect(confirmed.json()).toMatchObject({
      preview: { status: 'queued', disclosure: { sideEffectClass: 'unsafe' } },
    });
  } finally {
    await harness.close();
  }
});

function fixture() {
  const version = '1.0.0';
  const file = 'widgets.json';
  const body = JSON.stringify({
    format: 1,
    publisher: 'example',
    integration: 'widgets',
    version,
    hostRelease: { min: '0.0.0', below: '999.0.0' },
    origin,
    presentation: {
      name: 'Widgets',
      description: 'Widget inventory',
      icon: 'globe',
    },
    connection: {
      fields: { token: { label: 'Token', kind: 'secret' } },
      auth: { kind: 'bearer', field: 'token' },
      test: { method: 'GET', path: '/account' },
    },
    actions: [
      {
        key: 'list',
        name: 'List widgets',
        description: 'Read the widget inventory',
        connection: 'connection',
        input: {},
        output: { count: { type: 'integer', required: true } },
        method: 'GET',
        path: '/widgets',
        projection: 'body',
        sideEffect: 'safe',
      },
      {
        key: 'create',
        name: 'Create widget',
        description: 'Create a widget',
        input: {},
        output: {},
        method: 'POST',
        path: '/widgets',
        projection: {},
        sideEffect: 'unsafe',
      },
    ],
  });
  return { file, body, origin, version };
}
