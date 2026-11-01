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

import { recordCredentialAccess } from '../../connections/runtime/dispatch.repository.js';
import type { FailureNotificationStore } from '../contract.js';
import { auditFailureNotification } from './evidence.repository.js';
import { FailureNotificationStateError } from '../errors.js';

type DestinationStore = Pick<
  FailureNotificationStore,
  'fenceDispatch' | 'loadDestination'
>;

export function createFailureNotificationDestinationStore(
  pool: Pool,
): DestinationStore {
  return Object.freeze({
    loadDestination: (
      raw: Parameters<FailureNotificationStore['loadDestination']>[0],
    ) => loadNotificationDestination(pool, raw),
    fenceDispatch: (
      raw: Parameters<FailureNotificationStore['fenceDispatch']>[0],
    ) => fenceNotificationDispatch(pool, raw),
  });
}

async function loadNotificationDestination(
  pool: Pool,
  raw: Parameters<DestinationStore['loadDestination']>[0],
): ReturnType<DestinationStore['loadDestination']> {
  const workspaceId = raw.workspaceId;
  const intentId = raw.intentId;
  const workerId = raw.workerId;
  const attemptNumber = raw.attemptNumber;
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
    { signal: raw.signal, statementTimeoutMillis: 30_000 },
  );
}

async function fenceNotificationDispatch(
  pool: Pool,
  raw: Parameters<DestinationStore['fenceDispatch']>[0],
): ReturnType<DestinationStore['fenceDispatch']> {
  const workspaceId = raw.workspaceId;
  const intentId = raw.intentId;
  const attemptNumber = raw.attemptNumber;
  await withTenantScopedClient(
    pool,
    { workspaceId },
    async (client) => {
      const parsedBinding = raw.deliveryBinding ?? null;
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
          deliveryBinding: sql`coalesce(${intent.deliveryBinding},${parsedBinding})`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            scope,
            available,
            activeWorkspace,
            sql`((${parsedBinding}::text is null and ${intent.deliveryBinding} is null) or (${parsedBinding}::text is not null and (${intent.deliveryBinding} is null or ${intent.deliveryBinding}=${parsedBinding})))`,
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
    raw.signal === undefined ? {} : { signal: raw.signal },
  ).catch(rethrowQueryFailure);
}
