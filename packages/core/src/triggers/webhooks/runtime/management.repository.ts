import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflowTriggers,
  webhookTriggerEndpoints as endpoints,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import type {
  Command,
  ConfigureWebhookAuthenticationInput,
  ProvisionWebhookInput,
  RotateWebhookEndpointInput,
  RotateWebhookSecretInput,
} from './webhook-runtime.types.js';
import { MINUTE_INTERVAL } from '../../../shared/sql-intervals.repository.js';

/** How long a rotated-out secret still verifies, for senders mid-switch. */
const PREVIOUS_SECRET_GRACE_MINUTES = 5;

/** Finds the endpoint through its step, so a trigger row of any version addresses it. */
function endpointOfTrigger(input: Command) {
  return and(
    eq(endpoints.workspaceId, input.workspaceId),
    eq(endpoints.workflowId, input.workflowId),
    eq(
      endpoints.nodeId,
      sql`(select ${workflowTriggers.nodeId} from ${workflowTriggers}
        where ${workflowTriggers.workspaceId}=${input.workspaceId}
          and ${workflowTriggers.id}=${input.triggerId})`,
    ),
  );
}

/** The active endpoint's authentication, locked, or undefined when there's none. */
export async function lockEndpointAuthentication(
  client: PoolClient,
  input: Command,
) {
  const result = await drizzle(client)
    .select({ authentication: endpoints.authentication })
    .from(endpoints)
    .where(and(endpointOfTrigger(input), eq(endpoints.status, 'active')))
    .for('update')
    .catch(rethrowQueryFailure);
  return result[0]?.authentication;
}

/** A new authentication mode gets a new endpoint key and secret, with no grace. */
export async function replaceEndpointAuthentication(
  client: PoolClient,
  input: ConfigureWebhookAuthenticationInput,
  secretId: string,
): Promise<void> {
  await drizzle(client)
    .update(endpoints)
    .set({
      authentication: input.authentication,
      endpointKeyHash: input.endpointKeyHash,
      currentSecretVersionId: secretId,
      previousSecretVersionId: null,
      previousSecretValidUntil: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(endpointOfTrigger(input))
    .catch(rethrowQueryFailure);
}

export async function updateEndpointAuthentication(
  client: PoolClient,
  input: ConfigureWebhookAuthenticationInput,
): Promise<void> {
  await drizzle(client)
    .update(endpoints)
    .set({
      authentication: input.authentication,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(endpointOfTrigger(input))
    .catch(rethrowQueryFailure);
}

export async function lockWebhookTrigger(
  client: PoolClient,
  input: ProvisionWebhookInput,
) {
  const trigger = await drizzle(client)
    .select({
      workflow_id: workflowTriggers.workflowId,
      node_id: workflowTriggers.nodeId,
      status: workflowTriggers.status,
    })
    .from(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.workspaceId, input.workspaceId),
        eq(workflowTriggers.id, input.triggerId),
        eq(workflowTriggers.kind, 'webhook'),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return trigger[0];
}

export async function insertEndpoint(
  client: PoolClient,
  input: ProvisionWebhookInput,
  trigger: Readonly<{ workflow_id: string; node_id: string }>,
  secretId: string,
): Promise<void> {
  await drizzle(client)
    .insert(endpoints)
    .values({
      id: input.endpointId,
      workspaceId: input.workspaceId,
      workflowId: trigger.workflow_id,
      nodeId: trigger.node_id,
      endpointKeyHash: input.endpointKeyHash,
      currentSecretVersionId: secretId,
    })
    .catch(rethrowQueryFailure);
}

export async function activateWebhookTrigger(
  client: PoolClient,
  input: ProvisionWebhookInput,
): Promise<void> {
  await drizzle(client)
    .update(workflowTriggers)
    .set({
      status: 'active',
      healthStatus: 'healthy',
      reconciledAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(workflowTriggers.workspaceId, input.workspaceId),
        eq(workflowTriggers.id, input.triggerId),
      ),
    )
    .catch(rethrowQueryFailure);
}

/** False when there's no active endpoint to rotate. */
export async function rotateEndpointKey(
  client: PoolClient,
  input: RotateWebhookEndpointInput,
): Promise<boolean> {
  const result = await drizzle(client)
    .update(endpoints)
    .set({
      endpointKeyHash: input.endpointKeyHash,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(and(endpointOfTrigger(input), eq(endpoints.status, 'active')))
    .returning({ id: endpoints.id })
    .catch(rethrowQueryFailure);
  return result.length === 1;
}

/** The active endpoint under this key, locked for a secret rotation. */
export async function lockEndpointSecret(
  client: PoolClient,
  input: RotateWebhookSecretInput,
) {
  const endpoint = await drizzle(client)
    .select({
      current_secret_version_id: endpoints.currentSecretVersionId,
      authentication: endpoints.authentication,
    })
    .from(endpoints)
    .where(
      and(
        endpointOfTrigger(input),
        eq(endpoints.endpointKeyHash, input.endpointKeyHash),
        eq(endpoints.status, 'active'),
      ),
    )
    .for('update')
    .catch(rethrowQueryFailure);
  return endpoint[0];
}

/** The old secret keeps verifying for a short grace while senders switch. */
export async function rotateEndpointSecret(
  client: PoolClient,
  input: RotateWebhookSecretInput,
  secretId: string,
  previousSecretId: string,
): Promise<void> {
  await drizzle(client)
    .update(endpoints)
    .set({
      currentSecretVersionId: secretId,
      previousSecretVersionId: previousSecretId,
      previousSecretValidUntil: sql`clock_timestamp()+${PREVIOUS_SECRET_GRACE_MINUTES}*${MINUTE_INTERVAL}`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(endpointOfTrigger(input))
    .catch(rethrowQueryFailure);
}
