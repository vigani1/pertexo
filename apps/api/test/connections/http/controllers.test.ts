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
  CreateConnectionUseCase,
  GetConnectionUseCase,
  ListConnectionsUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
} from '../../../src/connections/use-cases/management.js';
import { LookupSlackChannelsUseCase } from '../../../src/connections/failure-notifications/slack-channel-lookup.js';
import { TestConnectionUseCase } from '../../../src/connections/use-cases/test-connection.js';
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

const useCases = {
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
    controllers: [ConnectionsController],
    providers: [
      { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
      { provide: ListConnectionsUseCase, useValue: useCases.list },
      { provide: GetConnectionUseCase, useValue: useCases.read },
      { provide: CreateConnectionUseCase, useValue: useCases.create },
      { provide: RotateConnectionSecretUseCase, useValue: useCases.rotate },
      { provide: RevokeConnectionUseCase, useValue: useCases.revoke },
      { provide: TestConnectionUseCase, useValue: useCases.test },
      { provide: LookupSlackChannelsUseCase, useValue: useCases.lookup },
    ],
  });
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  useCases.list.execute.mockResolvedValue({
    items: [connection],
    nextCursor: null,
  });
  for (const answer of [useCases.read, useCases.create, useCases.rotate])
    answer.execute.mockResolvedValue(connection);
  useCases.revoke.execute.mockResolvedValue({
    ...connection,
    status: 'revoked',
  });
  useCases.test.execute.mockResolvedValue({
    connection,
    outcome: { ok: true, httpStatus: 204, errorCode: null },
  });
  useCases.lookup.execute.mockResolvedValue({ items: [] });
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

const forwarded = (useCase: { execute: ReturnType<typeof vi.fn> }) =>
  useCase.execute.mock.calls[0]?.[0] as Record<string, unknown>;

describe('connection routes', () => {
  it('lists a page and reads one for the signed-in actor', async () => {
    const list = await harness.send('GET', connections, {
      query: { limit: '1', after: 'cursor-1' },
    });
    const read = await harness.send('GET', one);
    expect(list.statusCode, list.payload).toBe(200);
    expect(read.statusCode, read.payload).toBe(200);
    expect(forwarded(useCases.list)).toMatchObject({
      routeWorkspaceId: workspaceId,
      limit: 1,
      after: 'cursor-1',
      actor: { actorId, workspaceId },
    });
    expect(forwarded(useCases.read)).toMatchObject({
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
    expect(useCases.list.execute).not.toHaveBeenCalled();
  });

  it('looks up the listed Slack channels with the request signal', async () => {
    const reply = await harness.send('GET', `${one}/slack/channels`, {
      query: { channelIds: 'C0123,D0456' },
    });
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(useCases.lookup)).toMatchObject({
      connectionId,
      channelIds: ['C0123', 'D0456'],
    });
    expect(forwarded(useCases.lookup).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([{}, { channelIds: 'C0001,C0001' }, { channelIds: 'c0001' }])(
    'refuses Slack lookup query %j before the credential',
    async (query) => {
      const reply = await harness.send('GET', `${one}/slack/channels`, {
        query,
      });
      expect(reply.statusCode).toBe(400);
      expect(useCases.lookup.execute).not.toHaveBeenCalled();
    },
  );

  it('creates once, with the request, its key and the actor', async () => {
    const reply = await command('POST', connections, created);
    expect(reply.statusCode, reply.payload).toBe(201);
    expect(useCases.create.execute).toHaveBeenCalledOnce();
    expect(forwarded(useCases.create)).toMatchObject({
      routeWorkspaceId: workspaceId,
      request: created,
      idempotencyKey: 'command-42',
      actor: { actorId, workspaceId },
    });
  });

  it('rotates a secret with the identifiers, key and request signal', async () => {
    const reply = await command('PUT', `${one}/secret`, rotation);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(useCases.rotate)).toMatchObject({
      connectionId,
      request: rotation,
      idempotencyKey: 'command-42',
    });
    expect(forwarded(useCases.rotate).signal).toBeInstanceOf(AbortSignal);
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
    expect(useCases.create.execute).not.toHaveBeenCalled();
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
      for (const useCase of Object.values(useCases))
        expect(useCase.execute).not.toHaveBeenCalled();
    },
  );

  it('revokes with only the identifiers', async () => {
    const reply = await harness.send('DELETE', one);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(useCases.revoke)).toMatchObject({
      routeWorkspaceId: workspaceId,
      connectionId,
    });
    expect(forwarded(useCases.revoke)).not.toHaveProperty('request');
  });

  it('tests a connection with the request, key and signal', async () => {
    const body = { url: 'https://provider.example.test/health' };
    const reply = await command('POST', `${one}/test`, body);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(forwarded(useCases.test)).toMatchObject({
      connectionId,
      request: body,
      idempotencyKey: 'command-42',
      actor: { actorId, workspaceId },
    });
    expect(forwarded(useCases.test).signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { url: 'http://provider.example.test/health' },
    { url: `https://provider.example.test/${'😀'.repeat(700)}` },
    { providerKey: 'email' },
    { providerKey: 'email', sideEffectDisclosureAccepted: false },
  ])('refuses test request %# before claiming any work', async (body) => {
    const reply = await command('POST', `${one}/test`, body);
    expect(reply.statusCode).toBe(400);
    expect(useCases.test.execute).not.toHaveBeenCalled();
  });
});
