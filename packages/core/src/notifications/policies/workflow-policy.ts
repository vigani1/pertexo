import { z } from 'zod';
import { decodeStoredReceipt } from '../../shared/receipts.js';
import { FailureNotificationDestinationError } from '../destinations/notification-destination.errors.js';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflows,
  failureNotificationDestinations as destination,
  workflowFailureNotificationPolicies as policy,
} from '@pertexo/database/schema';
import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import { readFolderScope } from '../../shared/folder-access-facts.repository.js';
import { workflowAccessible } from '../../shared/resources/workflow-access.repository.js';

import {
  audit,
  claimNotificationCommand,
  completeNotificationCommand,
} from '../destinations/command.js';
import type {
  ClearWorkflowPolicyInput,
  FailureNotificationDestinationRecord,
  SetWorkflowPolicyInput,
  WorkflowPolicyInput,
} from '../destinations/notification-destination.types.js';
import { readFailureNotificationDestination } from '../destinations/notification-destinations.repository.js';

/**
 * The workflow's failure-notification policy (ADR 025): at most one
 * destination per workflow, read and chosen with workflow edit authority.
 */
export async function setWorkflowPolicy(
  client: PoolClient,
  input: SetWorkflowPolicyInput,
  role: Role,
): Promise<void> {
  const workflowId = input.workflowId;
  if (
    !(await workflowAccessible(
      client,
      await readFolderScope(client, input, role),
      {
        workspaceId: input.workspaceId,
        workflowId,
        capability: 'workflow:update',
      },
    ))
  )
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow is not visible',
    );
  const operation = 'workflow.failure.notification.policy.set';
  const scope = `${input.actorId}:${workflowId}`;
  const replay = await claimNotificationCommand(client, input, {
    operation,
    scope,
    resourceId: workflowId,
  });
  if (replay.kind === 'replay') {
    decodeStoredReceipt(z.null(), replay.result);
    return;
  }
  await readFailureNotificationDestination(
    client,
    input.workspaceId,
    input.destinationId,
  );
  const db = drizzle(client);
  const excluded = alias(policy, 'excluded');
  const result = await db
    .insert(policy)
    .select(
      db
        .select({
          workspaceId: workflows.workspaceId,
          workflowId: workflows.id,
          destinationId: destination.id,
          updatedBy: sql<string>`${input.actorId}::uuid`.as('updated_by'),
          updatedAt: sql`clock_timestamp()`.as('updated_at'),
        })
        .from(workflows)
        .innerJoin(
          destination,
          and(
            eq(destination.workspaceId, workflows.workspaceId),
            eq(destination.id, input.destinationId),
          ),
        )
        .where(
          and(
            eq(workflows.workspaceId, input.workspaceId),
            eq(workflows.id, workflowId),
            eq(destination.status, 'enabled'),
          ),
        ),
    )
    .onConflictDoUpdate({
      target: policy.workflowId,
      set: {
        destinationId: sql`${excluded.destinationId}`,
        updatedBy: sql`${excluded.updatedBy}`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({ id: policy.workflowId })
    .catch(rethrowQueryFailure);
  if (result.length !== 1)
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow or destination is not visible',
    );
  await audit(client, input, {
    action: 'workflow.failure_notification_policy_set',
    target: { id: workflowId, type: 'workflow' },
    metadata: { destinationId: input.destinationId },
  });
  await completeNotificationCommand(client, input, {
    operation,
    scope,
    result: null,
  });
}

export async function clearWorkflowPolicy(
  client: PoolClient,
  input: ClearWorkflowPolicyInput,
  role: Role,
): Promise<void> {
  const workflowId = input.workflowId;
  const db = drizzle(client);
  const existing = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .for('share')
    .catch(rethrowQueryFailure);
  // A deleted workflow has no remaining authority to resurrect; only its null receipt may replay.
  if (
    existing.length === 1 &&
    !(await workflowAccessible(
      client,
      await readFolderScope(client, input, role),
      {
        workspaceId: input.workspaceId,
        workflowId,
        capability: 'workflow:update',
      },
    ))
  )
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow is not visible',
    );
  const operation = 'workflow.failure.notification.policy.clear';
  const scope = `${input.actorId}:${workflowId}`;
  const replay = await claimNotificationCommand(client, input, {
    operation,
    scope,
    resourceId: workflowId,
  });
  if (replay.kind === 'replay') {
    decodeStoredReceipt(z.null(), replay.result);
    return;
  }
  if (existing.length !== 1)
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow is not visible',
    );
  const result = await db
    .delete(policy)
    .where(
      and(
        eq(policy.workspaceId, input.workspaceId),
        eq(policy.workflowId, workflowId),
      ),
    )
    .returning({ id: policy.workflowId })
    .catch(rethrowQueryFailure);
  if (result.length === 1)
    await audit(client, input, {
      action: 'workflow.failure_notification_policy_cleared',
      target: { id: workflowId, type: 'workflow' },
      metadata: {},
    });
  await completeNotificationCommand(client, input, {
    operation,
    scope,
    result: null,
  });
}

/**
 * The destination that currently receives the workflow's failure alerts, in
 * the same safe projection as destination reads, or null when none is set.
 * A disabled destination is still the current choice until it is replaced.
 */
export async function readWorkflowPolicy(
  client: PoolClient,
  input: WorkflowPolicyInput,
  role: Role,
): Promise<FailureNotificationDestinationRecord | null> {
  const workflowId = input.workflowId;
  if (
    !(await workflowAccessible(
      client,
      await readFolderScope(client, input, role),
      {
        workspaceId: input.workspaceId,
        workflowId,
        capability: 'workflow:read',
      },
    ))
  )
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow is not visible',
    );
  const [row] = await drizzle(client)
    .select({ destinationId: policy.destinationId })
    .from(workflows)
    .leftJoin(
      policy,
      and(
        eq(policy.workspaceId, workflows.workspaceId),
        eq(policy.workflowId, workflows.id),
      ),
    )
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  if (row === undefined)
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow is not visible',
    );
  const destinationId = row.destinationId;
  return destinationId === null
    ? null
    : readFailureNotificationDestination(
        client,
        input.workspaceId,
        destinationId,
      );
}
