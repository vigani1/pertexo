import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  rethrowQueryFailure,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { webhookTestEvents as listeners } from '@pertexo/database/schema';
import type { Pool } from 'pg';

import { WorkflowStepSampleError } from '../../../authoring/step-samples/errors.js';
import { inlineSampleOutput } from '../../../authoring/step-samples/records.repository.js';
import { WorkflowNotFoundError } from '../../../authoring/workflows/errors.js';
import { WebhookIngressRateLimitExceededError } from '../errors.js';
import { testEventDraftForCreator } from './authority.queries.js';
import type { TestEventReference, TestEventScope } from './contract.js';
import { WebhookTestEventError } from './errors.js';
import { listenerSelection, lockListener } from './records.queries.js';

const LISTENER_ATTEMPT_LIMIT = 60;

/**
 * What the test address does for an HTTP sender. No member is acting, so these stay off
 * the authority helper; the listener works while its creator could still edit the workflow.
 */
type Row = NonNullable<Awaited<ReturnType<typeof lockListener>>>;
const scopeOf = (r: Row): TestEventScope => ({
  workspaceId: r.workspaceId,
  workflowId: r.workflowId,
  nodeId: r.nodeId,
  actorId: r.createdBy,
});

export async function resolveTestEventListener(
  pool: Pool,
  hash: string,
): Promise<TestEventReference | null> {
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
          .select(listenerSelection)
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
        const draft = await testEventDraftForCreator(client, scopeOf(row));
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
            triggerId: row.id,
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

export async function consumeTestEventLimit(
  pool: Pool,
  reference: TestEventReference,
): Promise<void> {
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
            sql`${listeners.attempts}<${LISTENER_ATTEMPT_LIMIT}`,
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
              sql`${listeners.attempts}>=${LISTENER_ATTEMPT_LIMIT}`,
              sql`${listeners.expiresAt}>clock_timestamp()`,
              isNull(listeners.outputRef),
            ),
          )
          .catch(rethrowQueryFailure),
    );
    if (limited.length === 1)
      throw new WebhookIngressRateLimitExceededError(LISTENER_ATTEMPT_LIMIT);
    throw new WebhookTestEventError('unavailable');
  }
}

export async function captureTestEvent(
  pool: Pool,
  reference: TestEventReference,
  runInput: unknown,
): Promise<boolean> {
  return withTenantScopedClient(
    pool,
    { workspaceId: reference.workspaceId },
    async (client) => {
      // Read authority before the row lock, matching management's lock order.
      const result = await drizzle(client)
        .select(listenerSelection)
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
        draft = await testEventDraftForCreator(client, scopeOf(candidate));
      } catch (error) {
        if (
          error instanceof WorkflowNotFoundError ||
          error instanceof WebhookTestEventError
        )
          return false;
        throw error;
      }
      const row = await lockListener(client, scopeOf(candidate), candidate.id);
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
