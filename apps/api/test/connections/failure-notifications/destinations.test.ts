import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CONNECTION_OPERATION } from '../../../src/connections/telemetry.js';
import { TestConnectionUseCase } from '../../../src/connections/use-cases/test-connection.js';
import {
  authorization,
  connectionTestPersistence,
  sealed,
} from '../support/use-case-fixture.js';
import { FailureNotificationDestinationsController } from '../../../src/connections/failure-notifications/controller.js';
import { FailureNotificationDestinationUseCases } from '../../../src/connections/failure-notifications/destinations.js';
import { ConnectionsModule } from '../../../src/connections/module.js';
import { WORKSPACE_AUTHORIZATION } from '../../../src/workspaces/tokens.js';
import { FakeIdentityModule } from '../../support/identity-module.js';
import { ownerAccess, routeHarness } from '../../support/route-harness.js';
import { hashRequest } from '../../../src/connections/use-cases/support.js';
import {
  actorId,
  workspaceId,
  destinationId,
  workflowId,
  record,
  command,
  persistence,
  connectionId,
} from './destinations/fixture.js';
import { FailureNotificationDestinationError } from '@pertexo/core/testing';

describe('failure notification destination API seams', () => {
  it('accepts typed application commands for all seven operations', async () => {
    const database = persistence();
    const useCases = new FailureNotificationDestinationUseCases(
      database,
      'fixture-application-secret',
    );
    const mutation = { ...command, idempotencyKey: 'typed-command-42' };

    const created = await useCases.create({ ...mutation, body: record.config });
    const listed = await useCases.list(command);
    const fetched = await useCases.get({ ...command, destinationId });
    const appended = await useCases.append({
      ...mutation,
      destinationId,
      body: { expectedVersion: 1, config: record.config },
    });
    const status = await useCases.status({
      ...mutation,
      destinationId,
      body: { status: 'disabled' },
    });
    await useCases.setPolicy({
      ...mutation,
      workflowId,
      body: { destinationId },
    });
    await useCases.clearPolicy({ ...mutation, workflowId });

    const exactResponse = {
      id: destinationId,
      workspaceId,
      kind: 'slack',
      status: 'enabled',
      currentVersion: 1,
      config: record.config,
      createdAt: '2026-08-25T10:00:00.000Z',
      updatedAt: '2026-08-25T10:00:00.000Z',
    };
    expect(created).toEqual(exactResponse);
    expect(listed).toEqual({ items: [exactResponse] });
    expect(fetched).toEqual(exactResponse);
    expect(appended).toEqual(exactResponse);
    expect(status).toEqual(exactResponse);
    expect(
      JSON.stringify({ created, listed, fetched, appended, status }),
    ).not.toContain('must-not-escape');

    expect(database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        workspaceId,
        requestId: 'request-42',
        requestHash: hashRequest(
          'fixture-application-secret',
          workspaceId,
          CONNECTION_OPERATION.destinationCreate,
          record.config,
        ),
      }),
    );
    expect(database.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHash: hashRequest(
          'fixture-application-secret',
          workspaceId,
          CONNECTION_OPERATION.destinationAppend,
          {
            destinationId,
            expectedVersion: 1,
            config: record.config,
          },
        ),
      }),
    );
    expect(database.setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHash: hashRequest(
          'fixture-application-secret',
          workspaceId,
          CONNECTION_OPERATION.destinationStatus,
          { destinationId, status: 'disabled' },
        ),
      }),
    );
    expect(database.setWorkflowPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestHash: hashRequest(
          'fixture-application-secret',
          workspaceId,
          CONNECTION_OPERATION.policySet,
          { workflowId, destinationId },
        ),
      }),
    );
    expect(database.clearWorkflowPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        workspaceId,
        idempotencyKey: 'typed-command-42',
        requestHash: hashRequest(
          'fixture-application-secret',
          workspaceId,
          CONNECTION_OPERATION.policyClear,
          { workflowId },
        ),
      }),
    );
  });

  it('keeps GET idempotency-free and measures destination-specific commands', async () => {
    const database = persistence();
    const measured: string[] = [];
    const useCases = new FailureNotificationDestinationUseCases(
      database,
      'fixture-application-secret',
      {
        measure: <T>(operation: string, work: () => Promise<T>) => {
          measured.push(operation);
          return work();
        },
      },
    );

    await useCases.list(command);
    await useCases.status({
      ...command,
      idempotencyKey: 'destination-status-42',
      destinationId,
      body: { status: 'disabled' },
    });

    expect(database.list).toHaveBeenCalledWith(
      expect.not.objectContaining({
        idempotencyKey: expect.anything() as unknown,
      }),
    );
    expect(measured).toEqual(['failure_notification_destination.status']);
  });
});

describe('failure notification destination routes', () => {
  const database = persistence();
  const connectionTests = connectionTestPersistence();
  const open = vi.fn();
  const destinations = `/v1/workspaces/${workspaceId}/failure-notification-destinations`;
  const one = `${destinations}/${destinationId}`;
  const policy = `/v1/workspaces/${workspaceId}/workflows/${workflowId}/failure-notification-policy`;
  const projected = {
    id: destinationId,
    workspaceId,
    kind: 'slack',
    status: 'enabled',
    currentVersion: 1,
    config: record.config,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };
  let harness: Awaited<ReturnType<typeof routeHarness>>;

  beforeAll(async () => {
    harness = await routeHarness({
      module: ConnectionsModule,
      imports: [{ module: FakeIdentityModule }],
      controllers: [FailureNotificationDestinationsController],
      providers: [
        { provide: WORKSPACE_AUTHORIZATION, useValue: ownerAccess },
        {
          provide: FailureNotificationDestinationUseCases,
          useValue: new FailureNotificationDestinationUseCases(
            database,
            'fixture-application-secret',
          ),
        },
        {
          provide: TestConnectionUseCase,
          useValue: new TestConnectionUseCase(
            connectionTests,
            authorization(),
            {
              encryption: { seal: vi.fn().mockResolvedValue(sealed), open },
              httpClient: { execute: vi.fn() },
              applicationSecret: 'fixture-application-secret',
            },
          ),
        },
      ],
    });
  });
  afterAll(() => harness.close());
  beforeEach(() => vi.clearAllMocks());

  const send = (
    method: 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: unknown,
    key: string | null,
  ) =>
    harness.send(method, url, {
      ...(body === undefined ? {} : { body }),
      headers: key === null ? {} : { 'idempotency-key': key },
    });

  it('refuses a test of a changed destination before decrypting or dispatching', async () => {
    const reply = await send(
      'POST',
      `${one}/test`,
      { expectedVersion: 2, sideEffectDisclosureAccepted: true },
      'destination-test-42',
    );
    expect(reply.statusCode).toBe(409);
    expect(reply.json()).toMatchObject({ code: 'connection.conflict' });
    expect(open).not.toHaveBeenCalled();
    expect(connectionTests.startConnectionTest).not.toHaveBeenCalled();
  });

  it.each([
    { expectedVersion: 1, sideEffectDisclosureAccepted: false },
    {
      expectedVersion: 1,
      sideEffectDisclosureAccepted: true,
      channelId: 'COTHER',
    },
  ])(
    'refuses an undisclosed or caller-targeted test %j before reading',
    async (body) => {
      const reply = await send('POST', `${one}/test`, body, 'test-42');
      expect(reply.statusCode).toBe(400);
      expect(database.get).not.toHaveBeenCalled();
      expect(connectionTests.startConnectionTest).not.toHaveBeenCalled();
    },
  );

  it('creates with the signed-in actor, its key and a request hash', async () => {
    const reply = await send(
      'POST',
      destinations,
      { kind: 'slack', connectionId, channelId: 'C12345' },
      'destination-create-42',
    );
    expect(reply.statusCode, reply.payload).toBe(201);
    expect(reply.json()).toEqual(projected);
    expect(database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        actorId,
        idempotencyKey: 'destination-create-42',
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown,
        requestId: expect.any(String) as unknown,
      }),
    );
  });

  it.each([null, '', 'contains,comma'])(
    'refuses a create with idempotency key %j',
    async (key) => {
      const reply = await send('POST', destinations, record.config, key);
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toMatchObject({ code: 'request.invalid' });
      expect(database.create).not.toHaveBeenCalled();
    },
  );

  it('reads one destination without command metadata', async () => {
    const reply = await harness.send('GET', one);
    expect(reply.statusCode, reply.payload).toBe(200);
    expect(reply.json()).toEqual(projected);
    const [read] = vi.mocked(database.get).mock.calls[0] ?? [];
    expect(read).toMatchObject({ workspaceId, destinationId, actorId });
    expect(read).not.toHaveProperty('idempotencyKey');
  });

  it('reads the workflow policy through the safe destination projection', async () => {
    const current = await harness.send('GET', policy);
    expect(current.statusCode, current.payload).toBe(200);
    expect(current.json()).toEqual({ destination: projected });
    expect(current.payload).not.toContain('must-not-escape');
    expect(database.getWorkflowPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, workflowId, actorId }),
    );

    vi.mocked(database.getWorkflowPolicy).mockResolvedValueOnce(null);
    expect((await harness.send('GET', policy)).json()).toEqual({
      destination: null,
    });
    const invalid = await harness.send(
      'GET',
      policy.replace(workflowId, 'nope'),
    );
    expect(invalid.statusCode).toBe(400);
  });

  it('appends a version and answers its conflicts as conflicts', async () => {
    const body = {
      expectedVersion: 1,
      config: { ...record.config, channelId: 'C67890' },
    };
    const appended = await send('POST', `${one}/versions`, body, 'append-42');
    expect(appended.statusCode, appended.payload).toBe(200);
    expect(database.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        destinationId,
        expectedVersion: 1,
        config: body.config,
        idempotencyKey: 'append-42',
      }),
    );
    for (const code of ['conflict', 'idempotency_conflict'] as const) {
      vi.mocked(database.appendVersion).mockRejectedValueOnce(
        new FailureNotificationDestinationError(code),
      );
      const reply = await send('POST', `${one}/versions`, body, `a-${code}`);
      expect(reply.statusCode).toBe(409);
    }
  });

  it('replays setting and clearing a workflow policy with the same metadata', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const set = await send('PUT', policy, { destinationId }, 'policy-set-42');
      expect(set.statusCode, set.payload).toBe(204);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const clear = await send('DELETE', policy, undefined, 'policy-clear-42');
      expect(clear.statusCode, clear.payload).toBe(204);
    }
    const sets = vi.mocked(database.setWorkflowPolicy).mock.calls;
    expect(sets).toHaveLength(2);
    expect(sets[0]?.[0]).toMatchObject({
      workspaceId,
      workflowId,
      destinationId,
      idempotencyKey: 'policy-set-42',
      requestHash: sets[1]?.[0].requestHash,
    });
    const clears = vi.mocked(database.clearWorkflowPolicy).mock.calls;
    expect(clears).toHaveLength(2);
    expect(clears[0]?.[0].requestHash).toBe(clears[1]?.[0].requestHash);
  });

  it('answers a hidden destination as not found on read and write', async () => {
    vi.mocked(database.get).mockRejectedValueOnce(
      new FailureNotificationDestinationError('not_found'),
    );
    expect((await harness.send('GET', one)).statusCode).toBe(404);

    vi.mocked(database.appendVersion).mockRejectedValueOnce(
      new FailureNotificationDestinationError('not_found'),
    );
    const reply = await send(
      'POST',
      `${one}/versions`,
      { expectedVersion: 1, config: { ...record.config, channelId: 'C6' } },
      'destination-hidden-42',
    );
    expect(reply.statusCode).toBe(404);
  });
});
