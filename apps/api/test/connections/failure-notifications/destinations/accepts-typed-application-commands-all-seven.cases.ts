import { CONNECTION_OPERATION } from '../../../../src/connections/telemetry.js';
import { TestConnectionUseCase } from '../../../../src/connections/use-cases/test-connection.js';
import {
  authorization,
  connectionTestPersistence,
  sealed,
} from '../../support/use-case-fixture.js';

import { expect, it, vi } from 'vitest';
import { FailureNotificationDestinationsController } from '../../../../src/connections/failure-notifications/controller.js';
import { FailureNotificationDestinationUseCases } from '../../../../src/connections/failure-notifications/destinations.js';
import { createActorContext } from '../../../../src/authorization/index.js';
import { hashRequest } from '../../../../src/connections/use-cases/support.js';
import {
  actorId,
  workspaceId,
  destinationId,
  workflowId,
  record,
  request,
  command,
  persistence,
} from './fixture.js';

export function registerAcceptsTypedApplicationCommandsAllSeven(): void {
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

  it('refuses a changed destination before decrypting or dispatching a test', async () => {
    const database = persistence();
    const open = vi.fn();
    const connectionTests = connectionTestPersistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(
        database,
        'fixture-application-secret',
      ),
      new TestConnectionUseCase(connectionTests, authorization(), {
        encryption: { seal: vi.fn(), open },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
      }),
    );
    await expect(
      controller.test(
        request({ 'idempotency-key': 'destination-test-42' }),
        { workspaceId, destinationId },
        { expectedVersion: 2, sideEffectDisclosureAccepted: true },
      ),
    ).rejects.toMatchObject({ code: 'connection.conflict' });
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
    'rejects an undisclosed or caller-targeted destination test %j',
    async (body) => {
      const database = persistence();
      const connectionTests = connectionTestPersistence();
      const controller = new FailureNotificationDestinationsController(
        new FailureNotificationDestinationUseCases(
          database,
          'fixture-application-secret',
        ),
        new TestConnectionUseCase(connectionTests, authorization(), {
          encryption: { seal: vi.fn(), open: vi.fn() },
          httpClient: { execute: vi.fn() },
          applicationSecret: 'fixture-application-secret',
        }),
      );
      await expect(
        controller.test(
          request({ 'idempotency-key': 'destination-test-42' }),
          { workspaceId, destinationId },
          body,
        ),
      ).rejects.toMatchObject({ name: 'ZodError' });
      expect(database.get).not.toHaveBeenCalled();
      expect(connectionTests.startConnectionTest).not.toHaveBeenCalled();
    },
  );

  it('uses guarded actor identifiers consistently in destination commands', async () => {
    const database = persistence();
    const controller = new FailureNotificationDestinationsController(
      new FailureNotificationDestinationUseCases(
        database,
        'fixture-application-secret',
      ),
      new TestConnectionUseCase(connectionTestPersistence(), authorization(), {
        encryption: { seal: vi.fn().mockResolvedValue(sealed), open: vi.fn() },
        httpClient: { execute: vi.fn() },
        applicationSecret: 'fixture-application-secret',
      }),
    );
    const guardedActor = createActorContext({
      actorId: '99999999-9999-4999-8999-999999999999',
      workspaceId,
      sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: 'guard-request',
      traceId: 'guard-trace',
    });
    const authorizedWorkspace = {
      actor: guardedActor,
      workspaceId,
      role: 'owner' as const,
      capability: 'connection:manage' as const,
    };

    await controller.create(
      {
        ...request({ 'idempotency-key': 'guarded-destination' }),
        authorizedWorkspace,
      },
      { workspaceId },
      record.config,
    );

    expect(database.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: guardedActor.actorId,
        requestId: 'guard-request',
        traceId: 'guard-trace',
      }),
    );
  });
}
