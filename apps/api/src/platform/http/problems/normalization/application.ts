import { normalizeConcurrencyConflict } from '../concurrency-conflict.js';

import {
  strongEtagSchema,
  workflowRecoveryRefusalSchema,
} from '@pertexo/contracts';

import {
  APPLICATION_ERROR_CATALOG,
  type ApplicationError,
} from '../../application-error.js';

import { normalizeWorkflowMetadataConflict } from '../workflow-metadata-conflict.js';
import { normalizeAutoPauseConflict } from '../auto-pause-conflict.js';
import type { NormalizedProblem } from './contract.js';
import { text, unexpectedProblem, applicationProblemIssues } from './values.js';

export function fromApplicationError(
  error: ApplicationError,
): NormalizedProblem {
  const entry = APPLICATION_ERROR_CATALOG[error.code];
  const detail =
    entry.exposeDetail && error.safeDetail !== undefined
      ? text(error.safeDetail, 2_000)
      : undefined;
  const issues = applicationProblemIssues(error);
  const base = {
    code: error.code,
    status: entry.status,
    title: entry.title,
    ...(detail === undefined ? {} : { detail }),
    cause: error.cause,
    ...(issues === undefined ? {} : { errors: issues }),
  };
  const retryableProblem =
    error.code === 'request.rate_limited' ||
    error.code === 'request.rate_limit_unavailable' ||
    error.code === 'workspace.quota_exceeded' ||
    error.code === 'workspace.conflict' ||
    error.code === 'workflow.validation_unavailable';
  if (retryableProblem) return retryableApplicationProblem(base, error);
  if (error.code === 'run.recovery_unavailable') {
    const refusal = workflowRecoveryRefusalSchema.safeParse({
      kind: 'refused',
      reason: error.details?.reason,
    });
    return refusal.success
      ? { ...base, recoveryReason: refusal.data.reason }
      : unexpectedProblem(error);
  }
  const autoPauseConflict = normalizeAutoPauseConflict(error);
  if (autoPauseConflict !== undefined) return { ...base, autoPauseConflict };
  const concurrencyConflict = normalizeConcurrencyConflict(error);
  if (concurrencyConflict !== undefined)
    return { ...base, concurrencyConflict };
  const metadataConflict = normalizeWorkflowMetadataConflict(error);
  if (metadataConflict === 'invalid') return unexpectedProblem(error);
  if (metadataConflict !== undefined) return { ...base, ...metadataConflict };
  if (error.code !== 'workflow.revision_conflict') return base;
  return revisionConflictProblem(base, error);
}

function retryableApplicationProblem(
  base: NormalizedProblem,
  error: ApplicationError,
): NormalizedProblem {
  const retryAfterSeconds = error.details?.retryAfterSeconds;
  return typeof retryAfterSeconds === 'number' &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 1 &&
    retryAfterSeconds <= 300
    ? { ...base, retryAfterSeconds }
    : base;
}

function revisionConflictProblem(
  base: NormalizedProblem,
  error: ApplicationError,
): NormalizedProblem {
  const currentRevision = error.details?.currentRevision;
  const currentEtag = error.details?.currentEtag;
  const parsedEtag = strongEtagSchema.safeParse(currentEtag);
  const invalidRevisionConflict =
    typeof currentRevision !== 'number' ||
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 1 ||
    !parsedEtag.success;
  if (invalidRevisionConflict) return unexpectedProblem(error);
  return {
    ...base,
    revisionConflict: { currentRevision, currentEtag: parsedEtag.data },
  };
}
