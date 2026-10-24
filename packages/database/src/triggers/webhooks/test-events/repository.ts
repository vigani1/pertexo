import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { webhookTestEvents as listeners } from '../../../schema/triggers/test-events.js';
import { rethrowQueryFailure } from '../../../platform/query-errors.js';
import { appendAuditFact } from '../../../governance/audit/events.repository.js';
import type { Pool, PoolClient } from 'pg';

import type { DatabaseConfig } from '../../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../../platform/pool/runtime.js';
import { withTenantScopedClient } from '../../../tenant-access/transactions.js';
import { inlineSampleOutput } from '../../../authoring/step-samples/records.js';
import { parseStoredExecutionValue } from '../../../platform/stored-execution-value.js';
import { WorkflowStepSampleError } from '../../../authoring/step-samples/contract.js';
import { WorkflowNotFoundError } from '../../../authoring/workflows/errors.js';
import { WebhookIngressRateLimitExceededError } from '../errors.js';
import { testEventDraft } from './authority.queries.js';
import { WebhookTestEventError } from './errors.js';
import type { TestEventScope, WebhookTestEventStore } from './contract.js';

const selection = {
  ...getTableColumns(listeners),
  expired: sql<boolean>`${listeners.expiresAt}<=clock_timestamp()`,
  databaseTime: sql<Date>`clock_timestamp()`.mapWith(listeners.createdAt),
};
type Row = NonNullable<Awaited<ReturnType<typeof find>>>;
const scopeOf = (r: Row): TestEventScope => ({
  workspaceId: r.workspaceId,
  workflowId: r.workflowId,
  nodeId: r.nodeId,
  actorId: r.createdBy,
});

export function createWebhookTestEventStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WebhookTestEventStore {
  const lease = acquireDatabasePool(config, runtime);

  return {
    start: (input) => startTestEventListener(lease.pool, input),
    get: (input) => readTestEventListener(lease.pool, input),
    stop: (input) => stopTestEventListener(lease.pool, input),
    resolve: (hash) => resolveTestEventListener(lease.pool, hash),
    consume: (reference) => consumeTestEventLimit(lease.pool, reference),
    capture: (reference, runInput) =>
      captureTestEvent(lease.pool, reference, runInput),
    close: () => lease.close(),
  };
}

function transact<T>(
  pool: Pool,
  input: TestEventScope,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedClient(
    pool,
    { workspaceId: input.workspaceId, actorId: input.actorId },
    work,
    input.signal === undefined ? {} : { signal: input.signal },
  );
}
async function find(client: PoolClient, scope: TestEventScope, id: string) {
  const result = await drizzle(client)
    .select(selection)
    .from(listeners)
    .where(
      and(
        eq(listeners.workspaceId, scope.workspaceId),
        eq(listeners.workflowId, scope.workflowId),
        eq(listeners.nodeId, scope.nodeId),
        eq(listeners.createdBy, scope.actorId),
        eq(listeners.id, id),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return result[0];
}
function startTestEventListener(
  pool: Pool,
  input: Parameters<WebhookTestEventStore['start']>[0],
): ReturnType<WebhookTestEventStore['start']> {
  return transact(pool, input, async (client) => {
    const draft = await testEventDraft(client, input);
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
    if (Number(quota[0]?.count) >= 10)
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
  input: Parameters<WebhookTestEventStore['get']>[0],
): ReturnType<WebhookTestEventStore['get']> {
  return transact(pool, input, async (client) => {
    const draft = await testEventDraft(client, input);
    const row = await find(client, input, input.id);
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
  input: Parameters<WebhookTestEventStore['stop']>[0],
): ReturnType<WebhookTestEventStore['stop']> {
  return transact(pool, input, async (client) => {
    await testEventDraft(client, input);
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

async function resolveTestEventListener(
  pool: Pool,
  hash: Parameters<WebhookTestEventStore['resolve']>[0],
): ReturnType<WebhookTestEventStore['resolve']> {
  const resolution = await drizzle(pool)
    .execute<{ workspace_id: string; id: string }>(
      sql`select * from app.resolve_webhook_test_event(${hash}::char(64))`,
    )
    .catch(rethrowQueryFailure);
  const resolved = resolution.rows[0];
  if (resolved === undefined) return null;
  try {
    return await withTenantScopedClient(
      pool,
      { workspaceId: resolved.workspace_id },
      async (client) => {
        const result = await drizzle(client)
          .select(selection)
          .from(listeners)
          .where(
            and(
              eq(listeners.workspaceId, resolved.workspace_id),
              eq(listeners.id, resolved.id),
              eq(listeners.endpointKeyHash, hash),
              isNull(listeners.outputRef),
            ),
          )
          .catch(rethrowQueryFailure);
        const row = result[0];
        if (row === undefined || row.expired) return null;
        const draft = await testEventDraft(client, scopeOf(row));
        if (draft.binding !== row.binding) return null;
        return {
          endpointId: row.id,
          endpointKeyHash: hash,
          workspaceId: row.workspaceId,
          triggerId: row.id,
          workflowId: row.workflowId,
          nodeId: row.nodeId,
          databaseTime: row.databaseTime,
          authentication: row.authentication,
          ...(draft.config.runInput === undefined
            ? {}
            : { runInputMode: draft.config.runInput }),
          currentSecret: {
            id: row.id,
            kmsKeyReference: row.kmsKeyReference,
            encryptedDataKey: row.encryptedDataKey,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            authTag: row.authTag,
          },
        };
      },
    );
  } catch (error) {
    if (
      error instanceof WorkflowNotFoundError ||
      error instanceof WebhookTestEventError
    )
      return null;
    throw error;
  }
}

async function consumeTestEventLimit(
  pool: Pool,
  reference: Parameters<WebhookTestEventStore['consume']>[0],
): ReturnType<WebhookTestEventStore['consume']> {
  const allowed = await withTenantScopedClient(
    pool,
    { workspaceId: reference.workspaceId },
    (client) =>
      drizzle(client)
        .update(listeners)
        .set({ attempts: sql`${listeners.attempts}+1` })
        .where(
          and(
            eq(listeners.workspaceId, reference.workspaceId),
            eq(listeners.id, reference.endpointId),
            sql`${listeners.attempts}<60`,
            sql`${listeners.expiresAt}>clock_timestamp()`,
            isNull(listeners.outputRef),
          ),
        )
        .returning({ id: listeners.id })
        .catch(rethrowQueryFailure),
  );
  if (allowed.length !== 1) {
    const limited = await withTenantScopedClient(
      pool,
      { workspaceId: reference.workspaceId },
      (client) =>
        drizzle(client)
          .select({ one: sql`1` })
          .from(listeners)
          .where(
            and(
              eq(listeners.workspaceId, reference.workspaceId),
              eq(listeners.id, reference.endpointId),
              sql`${listeners.attempts}>=60`,
              sql`${listeners.expiresAt}>clock_timestamp()`,
              isNull(listeners.outputRef),
            ),
          )
          .catch(rethrowQueryFailure),
    );
    if (limited.length === 1)
      throw new WebhookIngressRateLimitExceededError(60);
    throw new WebhookTestEventError('unavailable');
  }
}

async function captureTestEvent(
  pool: Pool,
  reference: Parameters<WebhookTestEventStore['capture']>[0],
  runInput: Parameters<WebhookTestEventStore['capture']>[1],
): ReturnType<WebhookTestEventStore['capture']> {
  return withTenantScopedClient(
    pool,
    { workspaceId: reference.workspaceId },
    async (client) => {
      // Read authority before the row lock, matching management's lock order.
      const result = await drizzle(client)
        .select(selection)
        .from(listeners)
        .where(
          and(
            eq(listeners.workspaceId, reference.workspaceId),
            eq(listeners.id, reference.endpointId),
          ),
        )
        .catch(rethrowQueryFailure);
      const candidate = result[0];
      if (candidate === undefined) return false;
      let draft;
      try {
        draft = await testEventDraft(client, scopeOf(candidate));
      } catch (error) {
        if (
          error instanceof WorkflowNotFoundError ||
          error instanceof WebhookTestEventError
        )
          return false;
        throw error;
      }
      const row = await find(client, scopeOf(candidate), candidate.id);
      const listenerUnavailable =
        row === undefined ||
        row.expired ||
        row.outputRef !== null ||
        row.binding !== draft.binding;
      if (listenerUnavailable) return false;
      let output;
      try {
        output = inlineSampleOutput({
          kind: 'inline',
          value: runInput,
        });
      } catch (error) {
        if (error instanceof WorkflowStepSampleError)
          throw new WebhookTestEventError('value_invalid');
        throw error;
      }
      await drizzle(client)
        .update(listeners)
        .set({
          outputRef: output,
          receivedAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp()+interval '10 minutes'`,
        })
        .where(
          and(
            eq(listeners.workspaceId, reference.workspaceId),
            eq(listeners.id, reference.endpointId),
          ),
        )
        .catch(rethrowQueryFailure);
      return true;
    },
  );
}
