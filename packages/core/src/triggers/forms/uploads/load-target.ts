import { decodeStoredValue } from '../../../shared/stored-values.js';
import type { PoolClient } from 'pg';
import { rolesForCapability } from '@pertexo/policy';
import {
  inputRequestConfigSchema,
  type FormField,
} from '@pertexo/workflow-model';
import { authorizeForm, readFormVersion } from '../form-versions.repository.js';
import { FormUnavailableError } from '../form.errors.js';
import { lockWorkspaceAuthority } from '../../../shared/workspace-authority.js';
import { readFolderScope } from '../../../shared/folder-access-facts.repository.js';
import { readTaskUploadTarget } from '../../../runs/pending-tasks/responses/pending-task-records.repository.js';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
  requireVisibleTask,
} from '../../../runs/pending-tasks/responses/pending-task.errors.js';
import type { FormUploadTarget } from './form-upload.types.js';
import type { FormUploadBinding } from '../../../artifacts/form-uploads/bindings.repository.js';

export type LoadedUploadTarget = FormUploadBinding &
  Readonly<{ fields: readonly FormField[] }>;

export function uploadTargetScope(target: FormUploadTarget) {
  return target.kind === 'public_form'
    ? { workspaceId: target.grant.workspaceId }
    : { workspaceId: target.workspaceId, actorId: target.actorId };
}

/** Rechecks the link, membership or task eligibility each time, like a submission. */
export async function loadUploadTarget(
  client: PoolClient,
  target: FormUploadTarget,
  { write }: Readonly<{ write: boolean }>,
): Promise<LoadedUploadTarget> {
  if (target.kind === 'input_request') return loadInputRequest(client, target);
  const grant = target.kind === 'public_form' ? target.grant : undefined;
  const scope =
    target.kind === 'public_form'
      ? {
          workspaceId: target.grant.workspaceId,
          workflowId: target.grant.workflowId,
        }
      : target;
  await authorizeForm(client, scope, { grant, write });
  const loaded = await readFormVersion(client, scope, write ? 'share' : 'read');
  if (grant !== undefined && grant.nodeId !== loaded.nodeId)
    throw new FormUnavailableError();
  return {
    workspaceId: scope.workspaceId,
    workflowId: scope.workflowId,
    workflowVersionId: loaded.version.id,
    taskId: null,
    capabilityHash: grant?.capabilityHash ?? null,
    uploadedBy: target.kind === 'member_form' ? target.actorId : null,
    fields: loaded.form.fields,
  };
}

async function loadInputRequest(
  client: PoolClient,
  target: Extract<FormUploadTarget, { kind: 'input_request' }>,
): Promise<LoadedUploadTarget> {
  const role = await lockWorkspaceAuthority(
    client,
    target.workspaceId,
    target.actorId,
    rolesForCapability('run:read'),
  );
  const row = requireVisibleTask(
    await readTaskUploadTarget(client, target, {
      role,
      resources: await readFolderScope(client, target, role),
    }),
  );
  if (row.kind !== 'input_request')
    throw new PendingTaskNotFoundError('Task is not visible.');
  if (row.blocked_reason !== null)
    throw new PendingTaskDecisionError(row.blocked_reason);
  return {
    workspaceId: target.workspaceId,
    workflowId: row.workflow_id,
    workflowVersionId: null,
    taskId: row.id,
    capabilityHash: null,
    uploadedBy: target.actorId,
    fields: decodeStoredValue(() => inputRequestConfigSchema.parse(row.config))
      .fields,
  };
}
