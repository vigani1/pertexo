import { z } from 'zod';

import {
  audit,
  authorize,
  claimCommand,
  completeCommand,
  destinationError,
  type CommandMetadata,
  type DestinationTransaction,
  type IdempotentCommandMetadata,
} from './failure-notification-destination-commands.js';
import {
  readFailureNotificationDestination,
  type FailureNotificationDestinationRecord,
} from './failure-notification-destination-records.js';

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
    await authorize(client, input.workspaceId, input.actorId, false);
    const workflowId = z.uuid().parse(input.workflowId);
    const operation = 'workflow.failure.notification.policy.set';
    const scope = `${input.actorId}:${workflowId}`;
    const replay = await claimCommand(
      client,
      input,
      operation,
      scope,
      workflowId,
    );
    if (replay.kind === 'replay') return;
    await readFailureNotificationDestination(
      client,
      input.workspaceId,
      input.destinationId,
    );
    const result = await client.query(
      `insert into app.workflow_failure_notification_policies
           (workspace_id,workflow_id,destination_id,updated_by)
         select $1,workflow.id,$3,$4 from app.workflows workflow
          join app.failure_notification_destinations destination
            on destination.workspace_id=workflow.workspace_id and destination.id=$3
         where workflow.workspace_id=$1 and workflow.id=$2 and destination.status='enabled'
         on conflict (workflow_id) do update set destination_id=excluded.destination_id,
           updated_by=excluded.updated_by,updated_at=clock_timestamp()`,
      [input.workspaceId, workflowId, input.destinationId, input.actorId],
    );
    if (result.rowCount !== 1)
      throw destinationError(
        'not_found',
        'Workflow or destination is not visible',
      );
    await audit(
      client,
      input,
      'workflow.failure_notification_policy_set',
      { id: workflowId, type: 'workflow' },
      { destinationId: input.destinationId },
    );
    await completeCommand(client, input, operation, scope, null);
  });
}

export function clearWorkflowFailureNotificationPolicy(
  transaction: DestinationTransaction,
  input: IdempotentCommandMetadata & WorkflowPolicyScope,
): Promise<void> {
  return transaction(input, async (client) => {
    await authorize(client, input.workspaceId, input.actorId, false);
    const workflowId = z.uuid().parse(input.workflowId);
    const operation = 'workflow.failure.notification.policy.clear';
    const scope = `${input.actorId}:${workflowId}`;
    const replay = await claimCommand(
      client,
      input,
      operation,
      scope,
      workflowId,
    );
    if (replay.kind === 'replay') return;
    const workflow = await client.query(
      `select id from app.workflows
            where workspace_id=$1 and id=$2 for share`,
      [input.workspaceId, workflowId],
    );
    if (workflow.rowCount !== 1)
      throw destinationError('not_found', 'Workflow is not visible');
    const result = await client.query(
      `delete from app.workflow_failure_notification_policies where workspace_id=$1 and workflow_id=$2`,
      [input.workspaceId, workflowId],
    );
    if (result.rowCount === 1)
      await audit(
        client,
        input,
        'workflow.failure_notification_policy_cleared',
        { id: workflowId, type: 'workflow' },
        {},
      );
    await completeCommand(client, input, operation, scope, null);
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
    await authorize(client, input.workspaceId, input.actorId, false);
    const workflowId = z.uuid().parse(input.workflowId);
    const result = await client.query<{ destination_id: unknown }>(
      `select policy.destination_id from app.workflows workflow
         left join app.workflow_failure_notification_policies policy
           on policy.workspace_id=workflow.workspace_id
          and policy.workflow_id=workflow.id
        where workflow.workspace_id=$1 and workflow.id=$2`,
      [input.workspaceId, workflowId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw destinationError('not_found', 'Workflow is not visible');
    const destinationId = z.uuid().nullable().parse(row.destination_id);
    return destinationId === null
      ? null
      : readFailureNotificationDestination(
          client,
          input.workspaceId,
          destinationId,
        );
  });
}
