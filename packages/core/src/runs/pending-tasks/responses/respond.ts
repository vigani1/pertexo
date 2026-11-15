import { decodeStoredValue } from '../../../shared/stored-values.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../../governance/audit/facts.js';
import type { FolderScope } from '../../../shared/folder-access.types.js';
import type { PoolClient } from 'pg';
import {
  inputRequestConfigSchema,
  parseFormValues,
} from '@pertexo/workflow-model';
import { wakeWorkflowRun } from '../../../outbox/run-advance.repository.js';
import type { Role } from '@pertexo/policy';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
  requireVisibleTask,
} from './pending-task.errors.js';
import { projectTask, readTaskRow } from './pending-task-records.repository.js';
import { resolveFormFiles } from '../../../artifacts/form-uploads/resolve.repository.js';
import { requireReadableReceipt } from '../../../shared/receipts.js';
import { z } from 'zod';
import {
  findVisibleTaskRun,
  lockTaskRun,
  readResponder,
  settleTask,
  wakeTaskAncestors,
} from './task-responses.repository.js';
import {
  taskResponseCommand,
  taskResponseOutput,
  taskResponseRequest,
  taskResponseStatus,
  type TaskResponse,
} from './response.js';

const responseReceipt = z.object({ taskId: z.uuid(), status: z.string() });

export async function respondToTask(
  client: PoolClient,
  input: TaskResponse,
  role: Role,
  resources: FolderScope,
) {
  const runId = requireVisibleTask(
    await findVisibleTaskRun(client, input, resources),
  );
  await lockTaskRun(client, input.workspaceId, runId);
  const row = requireVisibleTask(
    await readTaskRow(client, input, { role, resources, locking: true }),
  );
  if (row.kind !== input.kind)
    throw new PendingTaskNotFoundError('Task is not visible.');
  const submitted =
    input.kind === 'input_request'
      ? parseFormValues(
          decodeStoredValue(() => inputRequestConfigSchema.parse(row.config))
            .fields,
          input.values,
        )
      : undefined;
  const status = taskResponseStatus(input);
  const command = taskResponseCommand(input);
  const replay = await claimCommand(client, {
    ...command,
    request: taskResponseRequest(input, submitted),
    resourceId: input.taskId,
  });
  if (replay !== null) {
    requireReadableReceipt(responseReceipt, replay);
    return { task: projectTask(row), replayed: true };
  }
  if (row.blocked_reason !== null)
    throw new PendingTaskDecisionError(row.blocked_reason);
  const values =
    submitted === undefined
      ? undefined
      : await responseFiles(client, input, row, submitted);
  const observation = await readResponder(client, input.actorId);
  if (observation === undefined)
    throw new Error('Decision identity and time unavailable');
  const { now, display_name } = observation;
  const output = taskResponseOutput(input, { values, now, display_name });
  const settled = await settleTask(client, {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    actorId: input.actorId,
    status,
    output,
    now,
  });
  if (!settled) throw new PendingTaskDecisionError('expired');
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action:
      input.kind === 'approval'
        ? 'pending_task.decided'
        : 'pending_task.submitted',
    targetType: 'pending_task',
    targetId: input.taskId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata:
      input.kind === 'approval'
        ? { runId, decision: status }
        : { runId, status },
  });
  await completeCommand(client, command, {
    taskId: input.taskId,
    status,
  });
  await wakeWorkflowRun(client, input.workspaceId, runId);
  await wakeTaskAncestors(client, input.workspaceId, runId);
  return {
    task: projectTask(
      requireVisibleTask(await readTaskRow(client, input, { role, resources })),
    ),
    replayed: false,
  };
}

/** Uploads count only if this responder began them for this task. */
function responseFiles(
  client: PoolClient,
  input: TaskResponse,
  row: NonNullable<Awaited<ReturnType<typeof readTaskRow>>>,
  submitted: ReturnType<typeof parseFormValues>,
) {
  return resolveFormFiles(
    client,
    {
      workspaceId: input.workspaceId,
      workflowId: row.workflow_id,
      workflowVersionId: null,
      taskId: input.taskId,
      capabilityHash: null,
      uploadedBy: input.actorId,
      session: input.kind === 'input_request' ? input.uploadSession : undefined,
    },
    decodeStoredValue(() => inputRequestConfigSchema.parse(row.config)).fields,
    submitted,
  );
}
