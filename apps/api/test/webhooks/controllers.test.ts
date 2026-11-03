import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { WebhookIngressDependencies } from '../../src/webhooks/ingress/register.js';
import type { WebhookManagementService } from '../../src/webhooks/management/webhook-management.service.js';
import { WebhookModule } from '../../src/webhooks/webhook.module.js';
import { FakeIdentityModule } from '../support/identity-module.js';
import {
  HARNESS_ACTOR_ID as actorId,
  ownerAccess,
  routeHarness,
} from '../support/route-harness.js';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const triggerId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const route = { workspaceId, workflowId, triggerId };
const triggers = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`;
const webhook = `${triggers}/${triggerId}/webhook`;
const endpointKey = 'a'.repeat(43);
const authentication = { mode: 'signed', allowedOrigins: [] };
const trigger = {
  id: triggerId,
  workflowId,
  workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nodeId: 'webhook',
  kind: 'webhook',
  status: 'active',
  healthStatus: 'healthy',
  lastErrorCode: null,
  endpointReady: true,
  authentication,
  reconciledAt: null,
};

const service = {
  list: vi.fn(),
  listDeliveries: vi.fn(),
  provision: vi.fn(),
  configureAuthentication: vi.fn(),
  rotateEndpoint: vi.fn(),
  rotateSecret: vi.fn(),
};
let harness: Awaited<ReturnType<typeof routeHarness>>;

beforeAll(async () => {
  harness = await routeHarness(
    WebhookModule.register(
      {
        service: service as unknown as WebhookManagementService,
        ingress: {} as WebhookIngressDependencies,
      },
      ownerAccess,
      { module: FakeIdentityModule },
    ),
  );
});
afterAll(() => harness.close());
beforeEach(() => {
  vi.clearAllMocks();
  service.list.mockResolvedValue({ items: [trigger] });
  service.listDeliveries.mockResolvedValue({ items: [], nextCursor: null });
  for (const command of [
    service.provision,
    service.configureAuthentication,
    service.rotateEndpoint,
    service.rotateSecret,
  ])
    command.mockResolvedValue({ trigger, replayed: true });
});

const command = (
  path: string,
  body?: unknown,
  idempotencyKey = 'webhook-command',
) =>
  harness.send('POST', `${webhook}/${path}`, {
    ...(body === undefined ? {} : { body }),
    headers: { 'idempotency-key': idempotencyKey },
  });

describe('webhook management routes', () => {
  it('lists the workflow triggers for the signed-in actor', async () => {
    const reply = await harness.send('GET', triggers);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(service.list).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      workflowId,
      actorId,
    });
  });

  it('pages deliveries only when the client asked to', async () => {
    await harness.send('GET', `${webhook}/deliveries`);
    await harness.send('GET', `${webhook}/deliveries`, {
      query: { limit: '50', after: 'opaque' },
    });
    expect(service.listDeliveries.mock.calls).toEqual([
      [{ ...route, actorId }],
      [{ ...route, actorId, limit: 50, after: 'opaque' }],
    ]);
  });

  it.each([{ limit: '0' }, { limit: '101' }, { cursor: 'x' }])(
    'refuses delivery query %j before reading',
    async (query) => {
      const reply = await harness.send('GET', `${webhook}/deliveries`, {
        query,
      });
      expect(reply.statusCode).toBe(400);
      expect(service.listDeliveries).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['provision', 'provision', undefined, {}],
    ['rotateEndpoint', 'rotate-endpoint', undefined, {}],
    ['rotateSecret', 'rotate-secret', { endpointKey }, { endpointKey }],
    [
      'configureAuthentication',
      'authentication',
      authentication,
      { authentication },
    ],
  ] as const)(
    'forwards %s with exactly its own material',
    async (method, path, body, material) => {
      const reply = await command(path, body);
      expect(reply.statusCode, reply.payload).toBe(200);
      const [sent] = service[method].mock.calls[0] as [Record<string, unknown>];
      const { signal, ...rest } = sent;
      expect(rest).toEqual({
        ...route,
        actorId,
        idempotencyKey: 'webhook-command',
        ...material,
      });
      expect(signal).toBeInstanceOf(AbortSignal);
    },
  );

  it.each([
    ['provision', { endpointKey }],
    ['rotate-endpoint', { force: true }],
    ['rotate-secret', {}],
    ['rotate-secret', { endpointKey: 'short' }],
    ['authentication', { mode: 'none' }],
  ])('refuses %s with body %j before the service', async (path, body) => {
    const reply = await command(path, body);
    expect(reply.statusCode).toBe(400);
    for (const method of Object.values(service))
      expect(method).not.toHaveBeenCalled();
  });

  it.each(['', 'first,second'])(
    'refuses idempotency key %j before mutation',
    async (key) => {
      const reply = await command('provision', undefined, key);
      expect(reply.statusCode).toBe(400);
      expect(service.provision).not.toHaveBeenCalled();
    },
  );

  it('refuses a command without an idempotency key', async () => {
    const reply = await harness.send('POST', `${webhook}/provision`);
    expect(reply.statusCode).toBe(400);
    expect(service.provision).not.toHaveBeenCalled();
  });
});
