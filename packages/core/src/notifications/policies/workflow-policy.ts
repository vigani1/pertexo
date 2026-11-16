import { z } from 'zod';
import { decodeStoredReceipt } from '../../shared/receipts.js';
import { FailureNotificationDestinationError } from '../destinations/notification-destination.errors.js';
import type { PoolClient } from 'pg';
import type { Role } from '@pertexo/policy';
import { readFolderScope } from '../../shared/access/folder-access-facts.repository.js';
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
import { readFailureNotificationDestination } from '../destinations/read-destination.js';
import {
  deleteWorkflowPolicy,
  readWorkflowPolicyChoice,
  saveWorkflowPolicy,
  shareLockWorkflow,
} from './workflow-policies.repository.js';

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
  const saved = await saveWorkflowPolicy(client, input);
  if (!saved)
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
  const exists = await shareLockWorkflow(client, input.workspaceId, workflowId);
  // A deleted workflow has no remaining authority to resurrect; only its null receipt may replay.
  if (
    exists &&
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
  if (!exists)
    throw new FailureNotificationDestinationError(
      'not_found',
      'Workflow is not visible',
    );
  const cleared = await deleteWorkflowPolicy(
    client,
    input.workspaceId,
    workflowId,
  );
  if (cleared)
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
  const row = await readWorkflowPolicyChoice(
    client,
    input.workspaceId,
    workflowId,
  );
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
