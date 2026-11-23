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
import { expect, it } from 'vitest';
import {
  authenticatedHeaders,
  cleanConnectionsRealNestHTTPStackFixture,
  connectionUrl,
  start,
} from './connection-http-fixture.js';

it('creates and reads an approved community connection through the HTTP routes', async () => {
  const parent = path.resolve(import.meta.dirname, '../../../../.pertexo/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'community-connection-'));
  try {
    const providerKey = 'community.example.widgets';
    const { file, body, origin, version } = fixture();
    await writeFile(path.join(root, file), body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    await loadPlatformRegistry(
      parseCommunityApprovalSet(
        root,
        JSON.stringify([{ file, providerKey, origin, version, sha256 }]),
      ),
    );

    const { application } = await start();
    const catalog = await application.inject({
      method: 'GET',
      url: catalogRoutes.nodeDefinitions.path,
      headers: authenticatedHeaders,
    });
    expect(catalog.statusCode, catalog.payload).toBe(200);
    const { connections } = nodeDefinitionListResponseSchema.parse(
      catalog.json(),
    );
    const form = connections.find((entry) => entry.providerKey === providerKey);
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
    const test = await application.inject({
      method: 'POST',
      url: `${connectionUrl}/${connection.id}/test`,
      headers: {
        ...authenticatedHeaders,
        'idempotency-key': 'test-community-connection',
      },
      payload: { providerKey },
    });
    expect(test.statusCode, test.payload).toBe(400);
  } finally {
    try {
      await cleanConnectionsRealNestHTTPStackFixture();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function fixture() {
  const origin = 'https://widgets.example.com';
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
    ],
  });
  return { file, body, origin, version };
}
