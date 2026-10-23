import { expect, it } from 'vitest';
import {
  ConnectionTestInProgressError,
  createInput,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerRecordsCompletedSSetupTest(): void {
  it.each(['dns_failed', 'ssrf_blocked'])(
    'records a completed %s setup test without claiming provider dispatch',
    async (reason) => {
      const input = createInput();
      await connections.api.createConnection(input);
      const common = {
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        idempotencyKey: `preflight-${input.connectionId}`,
        requestHash: 'a'.repeat(64),
        dispatchToken: randomUUID(),
      };
      await connections.api.startConnectionTest({
        ...common,
        expectedProviderKey: 'http',
      });
      await connections.api.resolveConnectionTestSecret({
        ...common,
        expectedProviderKey: 'http',
      });
      for (const outcome of [
        { ok: true as const, httpStatus: 200 },
        {
          ok: false as const,
          httpStatus: null,
          errorCode: 'connection.credential_rejected',
          reauthorizationRequired: true,
        },
      ]) {
        await expect(
          connections.api.completeConnectionTest({
            ...common,
            secretVersionId: input.secretVersionId,
            outcome,
          }),
        ).rejects.toBeInstanceOf(ConnectionTestInProgressError);
      }
      const outcome = {
        ok: false as const,
        httpStatus: null,
        errorCode: `connection.test.${reason}`,
        reauthorizationRequired: false,
      };
      const completed = await connections.api.completeConnectionTest({
        ...common,
        secretVersionId: input.secretVersionId,
        outcome,
      });
      expect(completed.connection).toMatchObject({
        status: 'active',
        lastHealthyAt: null,
        lastErrorCode: outcome.errorCode,
      });
      expect(completed.connection.lastTestedAt).toBeInstanceOf(Date);
      const listed = await connections.api.listConnections({
        workspaceId: workspaceA,
        actorId: ownerA,
      });
      expect(
        listed.items.find((item) => item.id === input.connectionId),
      ).toEqual(completed.connection);
      await expect(
        connections.api.startConnectionTest({
          ...common,
          dispatchToken: randomUUID(),
          expectedProviderKey: 'http',
        }),
      ).resolves.toEqual({ kind: 'replay', result: completed });
    },
  );

  it.each(['rotation', 'revocation', 'newer success'] as const)(
    'does not overwrite %s with an older pre-dispatch failure',
    async (change) => {
      const input = createInput();
      await connections.api.createConnection(input);
      const common = {
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        idempotencyKey: `preflight-race-${input.connectionId}`,
        requestHash: 'a'.repeat(64),
        dispatchToken: randomUUID(),
      };
      await connections.api.startConnectionTest({
        ...common,
        expectedProviderKey: 'http',
      });
      await connections.api.resolveConnectionTestSecret({
        ...common,
        expectedProviderKey: 'http',
      });
      if (change === 'rotation') {
        await connections.api.rotateConnectionSecret({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          expectedCurrentSecretVersionId: input.secretVersionId,
          secretVersionId: randomUUID(),
          sealed: sealed(7),
          idempotencyKey: `rotate-${input.connectionId}`,
          requestHash: '7'.repeat(64),
        });
      } else if (change === 'revocation') {
        await connections.api.revokeConnection({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
        });
      } else {
        const newer = {
          ...common,
          idempotencyKey: `newer-${input.connectionId}`,
          dispatchToken: randomUUID(),
          secretVersionId: input.secretVersionId,
        };
        await connections.api.startConnectionTest({
          ...newer,
          expectedProviderKey: 'http',
        });
        await connections.api.resolveConnectionTestSecret({
          ...newer,
          expectedProviderKey: 'http',
        });
        await connections.api.markConnectionTestDispatched(newer);
        await connections.api.completeConnectionTest({
          ...newer,
          outcome: { ok: true, httpStatus: 200 },
        });
      }
      const current = await connections.api.readConnection({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
      });
      const completed = await connections.api.completeConnectionTest({
        ...common,
        secretVersionId: input.secretVersionId,
        outcome: {
          ok: false,
          httpStatus: null,
          errorCode: 'connection.test.dns_failed',
          reauthorizationRequired: false,
        },
      });
      expect(completed.connection).toEqual(current);
    },
  );
}
