import { expect, it } from 'vitest';
import {
  ConnectionUnavailableError,
  Pool,
  adminUrl,
  createInput,
  databaseUrl,
  ownerA,
  randomUUID,
  sealed,
  workspaceA,
} from '../../support/connections.js';
import { connections } from './fixture.js';

export function registerRejectsDispatchWithoutAuditEvidence(): void {
  it.each(['rotate', 'revoke'] as const)(
    'rejects dispatch without audit evidence when credential %s commits first',
    async (mutation) => {
      const input = createInput();
      await connections.api.createConnection(input);
      const idempotencyKey = `mutation-first-${input.connectionId}`;
      const requestHash = 'f'.repeat(64);
      const dispatchToken = randomUUID();
      await connections.api.startConnectionTest({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken,
      });
      await connections.api.resolveConnectionTestSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        idempotencyKey,
        requestHash,
        dispatchToken,
      });
      if (mutation === 'rotate') {
        await connections.api.rotateConnectionSecret({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          expectedCurrentSecretVersionId: input.secretVersionId,
          secretVersionId: randomUUID(),
          sealed: sealed(8),
          idempotencyKey: `mutation-first-rotate-${input.connectionId}`,
          requestHash: '8'.repeat(64),
        });
      } else {
        await connections.api.revokeConnection({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
        });
      }
      await expect(
        connections.api.markConnectionTestDispatched({
          workspaceId: workspaceA,
          actorId: ownerA,
          connectionId: input.connectionId,
          idempotencyKey,
          requestHash,
          dispatchToken,
          secretVersionId: input.secretVersionId,
        }),
      ).rejects.toBeInstanceOf(ConnectionUnavailableError);

      const verifier = new Pool({ connectionString: databaseUrl(adminUrl) });
      try {
        const evidence = await verifier.query<{ count: string }>(
          `select count(*)::text as count from app.audit_events
           where target_id = $1 and action = 'connection.test_dispatched'`,
          [input.connectionId],
        );
        expect(evidence.rows[0]?.count).toBe('0');
      } finally {
        await verifier.end();
      }
    },
  );
}
