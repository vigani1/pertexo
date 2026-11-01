import { and, eq, exists, getTableName, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import {
  connectionSecretVersions as secret,
  workspaces,
  failureNotificationDestinations as destination,
  runFailureNotificationIntents as intent,
} from '@pertexo/database/schema';
import { currentDestinationSql, deliverySources } from './sources.queries.js';

import { recordCredentialAccess } from '../../connections/runtime/credential-use.repository.js';
import type {
  FailureNotificationResolvedDestination,
  FenceDispatchInput,
  LoadDestinationInput,
} from '../contract.js';
import { auditFailureNotification } from './evidence.repository.js';
import { FailureNotificationStateError } from '../errors.js';

export function loadDestination(
  pool: Pool,
  input: LoadDestinationInput,
): Promise<FailureNotificationResolvedDestination> {
  const { workspaceId, intentId, workerId, attemptNumber } = input;
  return withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      const db = drizzle(client);
      const source = db
        .$with('source')
        .as(
          deliverySources(db).where(
            and(
              eq(intent.workspaceId, workspaceId),
              eq(intent.id, intentId),
              eq(intent.status, 'claimed'),
              eq(intent.deliveryAttempts, attemptNumber),
              currentDestinationSql,
            ),
          ),
        );
      const [row] = await db
        .with(source)
        .select({
          config: source.config,
          secretVersionId: secret.id,
          sealed: {
            kmsKeyReference: secret.kmsKeyReference,
            encryptedDataKey: secret.encryptedDataKey,
            ciphertext: secret.ciphertext,
            nonce: secret.nonce,
            tag: secret.authTag,
          },
        })
        .from(source)
        .innerJoin(
          secret,
          and(
            eq(secret.workspaceId, workspaceId),
            eq(
              secret.connectionId,
              sql`(${source.config}->>'connectionId')::uuid`,
            ),
            eq(secret.id, source.secretVersionId),
          ),
        )
        .catch(rethrowQueryFailure);
      if (row === undefined)
        throw new FailureNotificationStateError(
          'Delivery destination is unavailable',
        );
      const config = row.config;
      const connectionId = config.connectionId;
      const secretVersionId = row.secretVersionId;
      await recordCredentialAccess(client, {
        workspaceId,
        connectionId,
        secretVersionId,
        workerId,
        traceId: null,
        purpose: 'failure_notification.deliver',
      });
      const resolved = {
        connectionId,
        secretVersionId,
        sealed: Object.freeze(row.sealed),
      };
      return config.kind === 'slack'
        ? Object.freeze({
            ...resolved,
            kind: config.kind,
            channelId: config.channelId,
          })
        : Object.freeze({
            ...resolved,
            kind: config.kind,
            toEmail: config.toEmail,
          });
    },
    { signal: input.signal, statementTimeoutMillis: 30_000 },
  );
}

export async function fenceDispatch(
  pool: Pool,
  input: FenceDispatchInput,
): Promise<void> {
  const { workspaceId, intentId, attemptNumber } = input;
  await withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      const binding = input.deliveryBinding ?? null;
      // The workspace must be active and the claimed intent's destination
      // enabled; both stay locked until the dispatch is marked.
      const db = drizzle(client);
      const scope = and(
        eq(intent.workspaceId, workspaceId),
        eq(intent.id, intentId),
        eq(intent.status, 'claimed'),
        eq(intent.deliveryAttempts, attemptNumber),
      );
      const workspace = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(eq(workspaces.id, workspaceId), eq(workspaces.status, 'active')),
        )
        .for('share')
        .catch(rethrowQueryFailure);
      const destinations =
        workspace.length === 1
          ? await db
              .select({ id: destination.id })
              .from(intent)
              .innerJoin(
                destination,
                and(
                  eq(destination.workspaceId, intent.workspaceId),
                  eq(destination.id, intent.destinationId),
                ),
              )
              .where(and(scope, eq(destination.status, 'enabled')))
              .for('share', {
                of: alias(destination, getTableName(destination)),
              })
              .catch(rethrowQueryFailure)
          : undefined;
      if (destinations?.length !== 1)
        throw new FailureNotificationStateError(
          'Delivery dispatch fence failed',
        );
      const activeWorkspace = exists(
        db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.status, 'active'),
            ),
          ),
      );
      const available = exists(
        deliverySources(db).where(and(scope, currentDestinationSql)),
      );
      const fenced = await db
        .update(intent)
        .set({
          status: 'dispatching',
          dispatchMarkedAt: sql`clock_timestamp()`,
          // Only a send that may have gone out holds the next attempt to its identity.
          deliveryBinding: sql`case when ${intent.possiblyDispatched} then coalesce(${intent.deliveryBinding},${binding}) else ${binding} end`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            scope,
            available,
            activeWorkspace,
            sql`(${intent.possiblyDispatched} is not true or (${binding}::text is null and ${intent.deliveryBinding} is null) or (${binding}::text is not null and (${intent.deliveryBinding} is null or ${intent.deliveryBinding}=${binding})))`,
          ),
        )
        .returning({ id: intent.id })
        .catch(rethrowQueryFailure);
      if (fenced.length !== 1)
        throw new FailureNotificationStateError(
          'Delivery dispatch fence failed',
        );
      await auditFailureNotification(client, {
        workspaceId,
        intentId,
        factType: 'dispatch_marked',
        attemptNumber,
        possiblyDispatched: false,
      });
    },
    input.signal === undefined ? {} : { signal: input.signal },
  ).catch(rethrowQueryFailure);
}
