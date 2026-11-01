import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import {
  workflows,
  failureNotificationDestinations as destination,
  workflowFailureNotificationPolicies as policy,
} from '@pertexo/database/schema';
import { authorizeWorkflowResource } from '../../tenant-access/resources/authority.js';

import {
  audit,
  authorize,
  claimNotificationCommand,
  completeNotificationCommand,
  destinationError,
} from '../destinations/command.js';
import type {
  CommandMetadata,
  DestinationTransaction,
  FailureNotificationDestinationRecord,
  IdempotentCommandMetadata,
} from '../destinations/contract.js';
import { readFailureNotificationDestination } from '../destinations/records.queries.js';

type WorkflowPolicyScope = Readonly<{ workflowId: string }>;

/**
 * The workflow's failure-notification policy (ADR 025): at most one
 * destination per workflow, read and chosen with workflow edit authority.
 */
export function setWorkflowFailureNotificationPolicy(
  transaction: DestinationTransaction,
  input: IdempotentCommandMetadata &
    WorkflowPolicyScope &
    Readonly<{ destinationId: string }>,
): Promise<void> {
  return transaction(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
    });
    const workflowId = input.workflowId;
    if (
      !(await authorizeWorkflowResource(
        client,
        { ...input, workflowId },
        { capability: 'workflow:update', locking: true },
      ))
    )
      throw destinationError('not_found', 'Workflow is not visible');
    const operation = 'workflow.failure.notification.policy.set';
    const scope = `${input.actorId}:${workflowId}`;
    const replay = await claimNotificationCommand(client, input, {
      operation,
      scope,
      resourceId: workflowId,
    });
    if (replay.kind === 'replay') return;
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
      throw destinationError(
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
  });
}

export function clearWorkflowFailureNotificationPolicy(
  transaction: DestinationTransaction,
  input: IdempotentCommandMetadata & WorkflowPolicyScope,
): Promise<void> {
  return transaction(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
    });
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
      !(await authorizeWorkflowResource(
        client,
        { ...input, workflowId },
        { capability: 'workflow:update', locking: true },
      ))
    )
      throw destinationError('not_found', 'Workflow is not visible');
    const operation = 'workflow.failure.notification.policy.clear';
    const scope = `${input.actorId}:${workflowId}`;
    const replay = await claimNotificationCommand(client, input, {
      operation,
      scope,
      resourceId: workflowId,
    });
    if (replay.kind === 'replay') return;
    if (existing.length !== 1)
      throw destinationError('not_found', 'Workflow is not visible');
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
  });
}

/**
 * The destination that currently receives the workflow's failure alerts, in
 * the same safe projection as destination reads, or null when none is set.
 * A disabled destination is still the current choice until it is replaced.
 */
export function readWorkflowFailureNotificationPolicy(
  transaction: DestinationTransaction,
  input: CommandMetadata & WorkflowPolicyScope,
): Promise<FailureNotificationDestinationRecord | null> {
  return transaction(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, {
      manage: false,
      browsing: true,
    });
    const workflowId = input.workflowId;
    if (
      !(await authorizeWorkflowResource(
        client,
        { ...input, workflowId },
        { capability: 'workflow:read', locking: true, browsing: true },
      ))
    )
      throw destinationError('not_found', 'Workflow is not visible');
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
      throw destinationError('not_found', 'Workflow is not visible');
    const destinationId = row.destinationId;
    return destinationId === null
      ? null
      : readFailureNotificationDestination(
          client,
          input.workspaceId,
          destinationId,
        );
  });
}
