import type { Role } from '@pertexo/policy';
import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import { PreviewAdmissionDeniedError } from '../../preview.errors.js';
import {
  lockActivePreviewWorkflow,
  lockPreviewDraft,
  previewWorkflowScope,
} from './admission.repository.js';

export async function assertAdmission(
  transaction: WorkspaceTransaction,
  workflowId: string,
  draftRevision: number,
) {
  if (!(await lockActivePreviewWorkflow(transaction, workflowId)))
    throw new PreviewAdmissionDeniedError('actor');
  const draft = await lockPreviewDraft(transaction, workflowId);
  if (draft === undefined) throw new PreviewAdmissionDeniedError('actor');
  if (draft.revision !== draftRevision)
    throw new PreviewAdmissionDeniedError('draft');
  return draft.graph;
}

export async function assertPreviewWorkflow(
  transaction: WorkspaceTransaction,
  role: Role,
  actorId: string,
  workflowId: string,
) {
  const resources = await previewWorkflowScope(
    transaction,
    role,
    actorId,
    workflowId,
  );
  if (resources === undefined) throw new PreviewAdmissionDeniedError('actor');
  return resources;
}
