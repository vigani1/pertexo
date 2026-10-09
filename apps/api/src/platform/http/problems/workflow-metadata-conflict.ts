import {
  workflowLifecycleRevisionSchema,
  workflowNameRevisionSchema,
} from '@pertexo/contracts';
import type { ApplicationError } from '../application-error.js';

type MetadataConflict = Readonly<{
  currentLifecycleRevision?: number;
  currentNameRevision?: number;
}>;

/** Organization conflicts are generic; lifecycle/name CAS commands retain their
 * typed current revision. Only validated metadata is eligible for projection. */
export function normalizeWorkflowMetadataConflict(
  error: ApplicationError,
): MetadataConflict | 'invalid' | undefined {
  if (error.code === 'workflow.lifecycle_conflict') {
    if (
      error.details?.conflictProjection === 'organization' &&
      error.details.currentLifecycleRevision === undefined
    )
      return {};
    const parsed = workflowLifecycleRevisionSchema.safeParse(
      error.details?.currentLifecycleRevision,
    );
    return parsed.success
      ? { currentLifecycleRevision: parsed.data }
      : 'invalid';
  }
  if (error.code === 'workflow.name_conflict') {
    const parsed = workflowNameRevisionSchema.safeParse(
      error.details?.currentNameRevision,
    );
    return parsed.success ? { currentNameRevision: parsed.data } : 'invalid';
  }
  return undefined;
}
