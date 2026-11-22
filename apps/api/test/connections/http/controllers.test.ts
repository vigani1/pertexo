import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { ConnectionsModule } from '../../../src/connections/connections.module.js';
import { ConnectionsController } from '../../../src/connections/http/connections.controller.js';
import {
  CreateConnectionService,
  GetConnectionService,
  ListConnectionsService,
  RevokeConnectionService,
  RotateConnectionSecretService,
} from '../../../src/connections/management/connection-management.js';
import { LookupConnectionOptionsService } from '../../../src/connections/lookups/lookup-options.service.js';
import { LookupConnectionOptionsController } from '../../../src/connections/lookups/lookup-options.controller.js';
import { TestConnectionService } from '../../../src/connections/testing/test-connection.js';
import type { WorkspaceAuthorizationSource } from '../../../src/authorization/index.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import {
  HARNESS_ACTOR_ID as actorId,
  ownerAccess,
  routeHarness,
} from '../../support/route-harness.js';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const connections = `/v1/workspaces/${workspaceId}/connections`;
const one = `${connections}/${connectionId}`;
const connection = {
  id: connectionId,
  workspaceId,
  providerKey: 'http',
  name: 'Operations API',
  authType: 'http_headers',
  status: 'active',
  secretVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: '2026-08-22T12:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z',
};
// Header names arrive in lower case, as the use case receives them.
const credential = {
  type: 'http_headers',
  headers: { authorization: 'Bearer secret' },
};
const rotation = {
  expectedSecretVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  credential,
};
const created = { providerKey: 'http', name: 'Operations API', credential };

const findAccess = vi.fn<WorkspaceAuthorizationSource['findAccess']>(
  ownerAccess.findAccess,
);

const services = {
  list: { execute: vi.fn() },
  read: { execute: vi.fn() },
  create: { execute: vi.fn() },
  rotate: { execute: vi.fn() },
  revoke: { execute: vi.fn() },
  test: { execute: vi.fn() },
  lookup: { execute: vi.fn() },
};
let harness: Awaited<ReturnType<typeof routeHarness>>;

/** The real routes, guards and parsing in front of use cases this test controls. */
beforeAll(async () => {
  harness = await routeHarness({
    module: ConnectionsModule,
    imports: [{ module: FakeIdentityModule }],
    controllers: [ConnectionsController, LookupConnectionOptionsController],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: { findAccess } },
      { provide: ListConnectionsService, useValue: services.list },
      { provide: GetConnectionService, useValue: services.read },
      { provide: CreateConnectionService, useValue: services.create },
      { provide: RotateConnectionSecretService, useValue: services.rotate },
      { provide: RevokeConnectionService, useValue: services.revoke },
      { provide: TestConnectionService, useValue: services.test },
      { provide: LookupConnectionOptionsService, useValue: services.lookup },
    ],
  });
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  services.list.execute.mockResolvedValue({
    items: [connection],
    nextCursor: null,
  });
  for (const answer of [services.read, services.create, services.rotate])
    answer.execute.mockResolvedValue(connection);
  services.revoke.execute.mockResolvedValue({
    ...connection,
    status: 'revoked',
  });
  services.test.execute.mockResolvedValue({
    connection,
    outcome: { ok: true, httpStatus: 204, errorCode: null },
  });
  services.lookup.execute.mockResolvedValue({ items: [] });
});

const command = (
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
  idempotencyKey: string | null = 'command-42',
) =>
  harness.send(method, url, {
    body,
    headers:
      idempotencyKey === null ? {} : { 'idempotency-key': idempotencyKey },
  });

const forwarded = (service: { execute: ReturnType<typeof vi.fn> }) =>
  service.execute.mock.calls[0]?.[0] as Record<string, unknown>;

describe('connection routes', () => {
  it('lists a page and reads one for the signed-in actor', async () => {
    const list = await harness.send('GET', connections, {
      query: { limit: '1', after: 'cursor-1' },
    });
    const read = await harness.send('GET', one);
    expect(list.statusCode, list.payload).toBe(200);
    expect(read.statusCode, read.payload).toBe(200);
    expect(forwarded(services.list)).toMatchObject({
      routeWorkspaceId: workspaceId,
      limit: 1,
      after: 'cursor-1',
      actor: { actorId, workspaceId },
    });
    expect(forwarded(services.read)).toMatchObject({
      routeWorkspaceId: workspaceId,
      connectionId,
      actor: { actorId, workspaceId },
    });
  });

  it('refuses an unknown list query field before reading', async () => {
    const reply = await harness.send('GET', connections, {
      query: { provider: 'http' },
    });
    expect(reply.statusCode).toBe(400);
    expect(services.list.execute).not.toHaveBeenCalled();
  });

  it('forwards a connection lookup with the request signal', async () => {
    const request = {
      providerKey: 'slack',
      lookup: 'channels',
      input: { channelIds: ['C0123', 'D0456'] },
    };
    const reply = await command('POST', `${one}/lookup`, request, null);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(services.lookup)).toMatchObject({ connectionId, request });
    expect(forwarded(services.lookup).signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a viewer before invoking the connection lookup', async () => {
    findAccess.mockResolvedValueOnce({
      ...(await ownerAccess.findAccess({ workspaceId })),
      role: 'viewer',
    });
    const reply = await command(
      'POST',
      `${one}/lookup`,
      {
        providerKey: 'slack',
        lookup: 'channels',
        input: { channelIds: ['C0123'] },
      },
      null,
    );
    expect(reply.statusCode).toBe(404);
    expect(services.lookup.execute).not.toHaveBeenCalled();
  });

  it.each([{}, { providerKey: 'slack', lookup: '' }])(
    'rejects an invalid lookup envelope before invoking the lookup',
    async (body) => {
      const reply = await command('POST', `${one}/lookup`, body, null);
      expect(reply.statusCode).toBe(400);
      expect(services.lookup.execute).not.toHaveBeenCalled();
    },
  );

  it('creates once, with the request, its key and the actor', async () => {
    const reply = await command('POST', connections, created);
    expect(reply.statusCode, reply.payload).toBe(201);
    expect(services.create.execute).toHaveBeenCalledOnce();
    expect(forwarded(services.create)).toMatchObject({
      routeWorkspaceId: workspaceId,
      request: created,
      idempotencyKey: 'command-42',
      actor: { actorId, workspaceId },
    });
  });

  it('rotates a secret with the identifiers, key and request signal', async () => {
    const reply = await command('PUT', `${one}/secret`, rotation);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(services.rotate)).toMatchObject({
      connectionId,
      request: rotation,
      idempotencyKey: 'command-42',
    });
    expect(forwarded(services.rotate).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    {
      providerKey: 'slack',
      credential: { type: 'slack_bot_token', botToken: 'xoxb-1234567890' },
    },
    {
      providerKey: 'email',
      credential: {
        type: 'resend_api_key',
        apiKey: 're_1234567890',
        fromEmail: 'ops@example.test',
      },
    },
    {
      providerKey: 'http',
      credential: {
        type: 'http_headers',
        headers: { authorization: 'Bearer fixture' },
      },
    },
    {
      providerKey: 'postgres',
      credential: {
        type: 'postgres',
        host: 'database.example.test',
        port: 5432,
        database: 'app',
        user: 'workflow',
        password: 'fixture-password',
        tls: 'require',
      },
    },
    {
      providerKey: 'email',
      credential: {
        type: 'smtp',
        host: 'smtp.example.test',
        port: 587,
        security: 'starttls',
        username: 'ops',
        password: 'fixture-password',
        fromEmail: 'ops@example.test',
      },
    },
    {
      providerKey: 'signing',
      credential: { type: 'hmac_key', signingKey: ' exact fixture key ' },
    },
    {
      providerKey: 'http',
      credential: {
        type: 'oauth2',
        settings: {
          grantType: 'client_credentials',
          tokenUrl: 'https://auth.example.test/token',
          clientId: 'workflows',
          scope: '',
          clientAuthentication: 'basic',
          tokenParameters: {},
          requestHosts: { mode: 'any' },
        },
        clientSecret: 'fixture-secret',
      },
    },
  ])(
    'admits creation and rotation for $credential.type without returning its fields',
    async ({ providerKey, credential }) => {
      const create = await command('POST', connections, {
        providerKey,
        name: 'Operations API',
        credential,
      });
      expect(create.statusCode, create.payload).toBe(201);
      expect(forwarded(services.create)).toMatchObject({
        request: { providerKey, credential },
      });
      expect(create.json()).not.toHaveProperty('credential');
      const rotate = await command('PUT', `${one}/secret`, {
        ...rotation,
        credential,
      });
      expect(rotate.statusCode, rotate.payload).toBe(200);
      expect(forwarded(services.rotate)).toMatchObject({
        request: { credential },
        expectedProviderKey: providerKey,
      });
      expect(rotate.json()).not.toHaveProperty('credential');
    },
  );

  it.each([
    [
      'ftp',
      { type: 'http_headers', headers: { authorization: 'fixture' } },
      '/providerKey',
    ],
    [
      'slack',
      { type: 'http_headers', headers: { authorization: 'fixture' } },
      '/credential/type',
    ],
    [
      'slack',
      { type: 'slack_bot_token', botToken: 'invalid-token-format' },
      '/credential/botToken',
    ],
  ] as const)(
    'keeps the input pointer for an inadmissible %s credential',
    async (providerKey, credential, path) => {
      const response = await command('POST', connections, {
        ...created,
        providerKey,
        credential,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        errors: [expect.objectContaining({ path })],
      });
      expect(services.create.execute).not.toHaveBeenCalled();
    },
  );

  it('refuses an unknown rotation credential before the command runs', async () => {
    const response = await command('PUT', `${one}/secret`, {
      ...rotation,
      credential: { type: 'unknown' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [expect.objectContaining({ path: '/credential/type' })],
    });
    expect(services.rotate.execute).not.toHaveBeenCalled();
  });

  it('refuses a credential header that would redirect the request', async () => {
    const reply = await command('POST', connections, {
      ...created,
      credential: {
        type: 'http_headers',
        headers: { Host: 'metadata.internal' },
      },
    });
    expect(reply.statusCode).toBe(400);
    expect(services.create.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['create', 'POST', connections, created],
    ['rotation', 'PUT', `${one}/secret`, rotation],
    ['test', 'POST', `${one}/test`, { url: 'https://example.test/health' }],
  ] as const)(
    'refuses %s without one well-formed idempotency key',
    async (_name, method, url, body) => {
      for (const key of [null, '', 'first,second'])
        expect((await command(method, url, body, key)).statusCode).toBe(400);
      for (const service of Object.values(services))
        expect(service.execute).not.toHaveBeenCalled();
    },
  );

  it('revokes with only the identifiers', async () => {
    const reply = await harness.send('DELETE', one);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(services.revoke)).toMatchObject({
      routeWorkspaceId: workspaceId,
      connectionId,
    });
    expect(forwarded(services.revoke)).not.toHaveProperty('request');
  });

  it('tests a connection with the request, key and signal', async () => {
    const body = { url: 'https://provider.example.test/health' };
    const reply = await command('POST', `${one}/test`, body);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(services.test)).toMatchObject({
      connectionId,
      request: body,
      idempotencyKey: 'command-42',
      actor: { actorId, workspaceId },
    });
    expect(forwarded(services.test).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { url: 'http://provider.example.test/health' },
    { url: `https://provider.example.test/${'😀'.repeat(700)}` },
    { providerKey: 'email' },
    { providerKey: 'future_provider' },
    { providerKey: 'slack', sideEffectDisclosureAccepted: true },
    { providerKey: 'email', sideEffectDisclosureAccepted: false },
  ])('refuses test request %# before claiming any work', async (body) => {
    const reply = await command('POST', `${one}/test`, body);
    expect(reply.statusCode).toBe(400);
    expect(services.test.execute).not.toHaveBeenCalled();
  });
});
