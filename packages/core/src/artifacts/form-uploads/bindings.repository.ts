import { createHash } from 'node:crypto';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { formUploads } from '@pertexo/database/schema';

/** The response an upload belongs to; a submission may only use matching uploads. */
export type FormUploadBinding = Readonly<{
  workspaceId: string;
  workflowId: string;
  workflowVersionId: string | null;
  taskId: string | null;
  capabilityHash: string | null;
  uploadedBy: string | null;
}>;
export const formUploadSessionHash = (session: string) =>
  createHash('sha256').update(session).digest('hex');

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
