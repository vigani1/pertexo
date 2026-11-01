import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  connections,
  connectionOAuth2Tokens as tokens,
} from '@pertexo/database/schema';

import { CONNECTION_EVENT_TYPE, CONNECTION_STATUS } from '../contract.js';
import { appendConnectionEvent } from '../events.repository.js';
import { selectConnection } from '../records.queries.js';
import { withConnectionTransaction } from '../transaction.js';
import type {
  CommitOAuth2RefreshInput,
  LoseOAuth2GrantInput,
  OAuth2GrantLossActor,
} from './contract.js';
import { expiryOf, sealedColumns, versionIs } from './token-columns.js';

/** A refresh changes the token row and lastHealthyAt: never an event or a revision. */
export async function commitRefresh(
  pool: Pool,
  input: CommitOAuth2RefreshInput,
): Promise<boolean> {
  const { workspaceId } = input;
  return withConnectionTransaction(pool, { workspaceId }, async (client) => {
    await selectConnection(client, workspaceId, input.connectionId, {
      lock: true,
    });
    const { issued } = input;
    const updated = await drizzle(client)
      .update(tokens)
      .set({
        id: issued.id,
        ...sealedColumns(issued),
        issuedAt: sql`clock_timestamp()`,
        accessTokenExpiresAt: expiryOf(issued),
        renewable: issued.renewable,
        refreshBlockedUntil: null,
      })
      .where(versionIs(input))
      .returning({ id: tokens.id })
      .catch(rethrowQueryFailure);
    if (updated.length !== 1) return false;
    await drizzle(client)
      .update(connections)
      .set({ lastHealthyAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          eq(connections.id, input.connectionId),
        ),
      )
      .catch(rethrowQueryFailure);
    return true;
  });
}

function lossActor(actor: OAuth2GrantLossActor) {
  return actor.source === 'run'
    ? ({
        actorKind: 'worker',
        actorId: actor.workerId,
        requestId: null,
        traceId: null,
      } as const)
    : ({
        actorKind: 'user',
        actorId: actor.actorId,
        requestId: actor.requestId ?? null,
        traceId: actor.traceId ?? null,
      } as const);
}

export async function loseGrant(
  pool: Pool,
  input: LoseOAuth2GrantInput,
): Promise<boolean> {
  const { workspaceId } = input;
  return withConnectionTransaction(pool, { workspaceId }, async (client) => {
    await selectConnection(client, workspaceId, input.connectionId, {
      lock: true,
    });
    const db = drizzle(client);
    const deleted = await db
      .delete(tokens)
      .where(versionIs(input))
      .returning({ id: tokens.id })
      .catch(rethrowQueryFailure);
    if (deleted.length !== 1) return false;
    await db
      .update(connections)
      .set({
        status: CONNECTION_STATUS.reauthorizationRequired,
        lastErrorCode: input.errorCode,
        healthRevision: sql`${connections.healthRevision}+1`,
        lastHealthTransitionAt: sql`clock_timestamp()`,
        lastHealthTransitionSource: input.actor.source,
        ...(input.actor.source === 'run'
          ? { lastRunObservedAt: sql`clock_timestamp()` }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(connections.workspaceId, workspaceId),
          eq(connections.id, input.connectionId),
        ),
      )
      .catch(rethrowQueryFailure);
    await appendConnectionEvent(client, {
      workspaceId,
      connectionId: input.connectionId,
      eventType: CONNECTION_EVENT_TYPE.reauthorizationRequired,
      ...lossActor(input.actor),
      metadata: {
        source: input.actor.source,
        status: CONNECTION_STATUS.reauthorizationRequired,
        reasonCode: input.errorCode,
      },
    });
    return true;
  });
}
