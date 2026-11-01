import { createHash } from 'node:crypto';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import {
  inputRequestConfigSchema,
  rolesForCapability,
  type FormField,
} from '@pertexo/workflow-model';
import { formUploads } from '@pertexo/database/schema';
import {
  authorizeForm,
  readFormVersion,
} from '../../triggers/forms/records.queries.js';
import { FormUnavailableError } from '../../triggers/forms/errors.js';
import { lockWorkspaceAuthority } from '../../shared/authority.queries.js';
import { readFolderScope } from '../../shared/facts.queries.js';
import { readTaskRow } from '../../runs/pending-tasks/responses/records.repository.js';
import {
  PendingTaskDecisionError,
  PendingTaskNotFoundError,
} from '../../runs/pending-tasks/responses/errors.js';
import type { FormUploadTarget } from './contract.js';

/** The response an upload belongs to; a submission may only use matching uploads. */
export type FormUploadBinding = Readonly<{
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string | null;
  taskId: string | null;
  capabilityHash: string | null;
  uploadedBy: string | null;
}>;
export type LoadedUploadTarget = FormUploadBinding &
  Readonly<{ fields: readonly FormField[] }>;

export const formUploadSessionHash = (session: string) =>
  createHash('sha256').update(session).digest('hex');

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
  const row = await readTaskRow(client, target, {
    role,
    resources: await readFolderScope(client, target, role),
  });
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
    fields: inputRequestConfigSchema.parse(row.config).fields,
  };
}

const matches = (column: Parameters<typeof eq>[0], value: string | null) =>
  value === null ? isNull(column) : eq(column, value);

/** Rows begun by the same response: target, responder and session. */
export function boundUploadsSql(
  binding: FormUploadBinding,
  session: string,
): SQL | undefined {
  return and(
    eq(formUploads.workspaceId, binding.workspaceId),
    eq(formUploads.workflowId, binding.workflowId),
    matches(formUploads.workflowVersionId, binding.workflowVersionId),
    matches(formUploads.taskId, binding.taskId),
    matches(formUploads.capabilityHash, binding.capabilityHash),
    matches(formUploads.uploadedBy, binding.uploadedBy),
    eq(formUploads.sessionHash, formUploadSessionHash(session)),
  );
}
