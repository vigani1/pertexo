import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { webhookTestEvents as listeners } from '@pertexo/database/schema';
import {
  rethrowQueryFailure,
  appendAuditFact,
} from '@pertexo/database/primitives';
import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/workflow-model';
import { parseStoredExecutionValue } from '../../../runs/values/stored-execution.js';
import type { Pool, PoolClient } from 'pg';

import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { WorkflowNotFoundError } from '../../../authoring/workflows/errors.js';
import { withWorkflowAccess } from '../../workflow-access.js';
import { readTestEventDraft } from './authority.queries.js';
import {
  captureTestEvent,
  consumeTestEventLimit,
  resolveTestEventListener,
} from './ingress.repository.js';
import { lockListener } from './records.queries.js';
import { WebhookTestEventError } from './errors.js';
import type {
  StartTestEventInput,
  TestEventListenerInput,
  TestEventReference,
  TestEventScope,
  TestEventSnapshot,
} from './contract.js';

const WORKSPACE_LISTENER_LIMIT = 10;

export type WebhookTestEventStore = ReturnType<
  typeof createWebhookTestEventStore
>;

export function createWebhookTestEventStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);

  return {
    start: (input: StartTestEventInput) =>
      startTestEventListener(lease.pool, input),
    get: (input: TestEventListenerInput) =>
      readTestEventListener(lease.pool, input),
    stop: (input: TestEventListenerInput) =>
      stopTestEventListener(lease.pool, input),
    // These answer an HTTP sender rather than a member, so they stay off the helper.
    resolve: (hash: string) => resolveTestEventListener(lease.pool, hash),
    consume: (reference: TestEventReference) =>
      consumeTestEventLimit(lease.pool, reference),
    capture: (reference: TestEventReference, runInput: unknown) =>
      captureTestEvent(lease.pool, reference, runInput),
    close: () => lease.close(),
  };
}

/** Starting, watching and stopping a listener lock it, so even the read is a change. */
function transact<T>(
  pool: Pool,
  input: TestEventScope,
  work: (client: PoolClient) => Promise<T>,
) {
  return withWorkflowAccess(
    pool,
    input,
    {
      mode: 'change',
      capability: 'workflow:update',
      statuses: ACTIVE_WORKSPACE_STATUSES,
      folderCapability: 'workflow:update',
      denied: () => new WorkflowNotFoundError('Workflow is not visible'),
    },
    work,
  );
}
function startTestEventListener(
  pool: Pool,
  input: StartTestEventInput,
): Promise<{ expiresAt: string }> {
  return transact(pool, input, async (client) => {
    const draft = await readTestEventDraft(client, input);
    if (draft.revision !== input.expectedDraftRevision)
      throw new WebhookTestEventError('changed');
    const db = drizzle(client);
    await db
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`webhook-test-events:${input.workspaceId}`},0))`,
      )
      .catch(rethrowQueryFailure);
    await db
      .delete(listeners)
      .where(
        and(
          eq(listeners.workspaceId, input.workspaceId),
          sql`(${listeners.workflowId}=${input.workflowId} or ${listeners.expiresAt}<=clock_timestamp())`,
        ),
      )
      .catch(rethrowQueryFailure);
    const quota = await db
      .select({ count: sql<string>`count(*)::text` })
      .from(listeners)
      .where(eq(listeners.workspaceId, input.workspaceId))
      .catch(rethrowQueryFailure);
    if (Number(quota[0]?.count) >= WORKSPACE_LISTENER_LIMIT)
      throw new WebhookTestEventError('limit_reached');
    const s = input.secret;
    const result = await db
      .insert(listeners)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        nodeId: input.nodeId,
        createdBy: input.actorId,
        endpointKeyHash: input.endpointKeyHash,
        binding: draft.binding,
        authentication: input.authentication,
        kmsKeyReference: s.kmsKeyReference,
        encryptedDataKey: s.encryptedDataKey,
        ciphertext: s.ciphertext,
        nonce: s.nonce,
        authTag: s.authTag,
        expiresAt: sql`clock_timestamp()+interval '120 seconds'`,
      })
      .returning({ expiresAt: listeners.expiresAt })
      .catch(rethrowQueryFailure);
    const row = result[0];
    if (row === undefined) throw new Error('Test listener was not created');
    await appendAuditFact(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'webhook.test.listen',
      targetType: 'workflow',
      targetId: input.workflowId,
      metadata: {
        nodeId: input.nodeId,
        authenticationMode: input.authentication.mode,
      },
    });
    return { expiresAt: row.expiresAt.toISOString() };
  });
}

function readTestEventListener(
  pool: Pool,
  input: TestEventListenerInput,
): Promise<TestEventSnapshot> {
  return transact(pool, input, async (client) => {
    const draft = await readTestEventDraft(client, input);
    const row = await lockListener(client, input, input.id);
    if (row === undefined || row.expired)
      return { state: 'expired', expiresAt: null, output: null };
    if (row.binding !== draft.binding)
      return {
        state: 'changed',
        expiresAt: row.expiresAt.toISOString(),
        output: null,
      };
    return {
      state: row.outputRef === null ? 'waiting' : 'captured',
      expiresAt: row.expiresAt.toISOString(),
      output:
        row.outputRef === null
          ? null
          : parseStoredExecutionValue(row.outputRef),
    };
  });
}

function stopTestEventListener(
  pool: Pool,
  input: TestEventListenerInput,
): Promise<void> {
  return transact(pool, input, async (client) => {
    await readTestEventDraft(client, input);
    await drizzle(client)
      .delete(listeners)
      .where(
        and(
          eq(listeners.workspaceId, input.workspaceId),
          eq(listeners.workflowId, input.workflowId),
          eq(listeners.nodeId, input.nodeId),
          eq(listeners.createdBy, input.actorId),
          eq(listeners.id, input.id),
        ),
      )
      .catch(rethrowQueryFailure);
  });
}
