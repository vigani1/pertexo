import {
  ArtifactIntegrityError,
  ArtifactNotFoundError,
} from '@pertexo/artifact-store';
import {
  ArtifactQuotaExceededError,
  ArtifactUploadConflictError,
  ArtifactUploadIdempotencyConflictError,
  ArtifactUploadNotFoundError,
} from '@pertexo/database/runs';
import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  ArtifactUploadTooLargeError,
  ArtifactApiNotFoundError,
  ArtifactApiConflictError,
  ArtifactUploadDeadlineError,
  ArtifactApiUnavailableError,
} from '../../artifacts/errors.js';
import { applicationError } from '../../platform/http/index.js';

export const artifactProblems = [
  errorRegistration(ArtifactUploadTooLargeError, () => {
    return applicationError('artifact.too_large', {
      safeDetail:
        'The file exceeds 10 MB or the configured lower storage limit. Split it into smaller files and upload them separately.',
    });
  }),
  errorRegistration(ArtifactApiNotFoundError, () => {
    return applicationError('resource.not_found');
  }),
  errorRegistration(ArtifactQuotaExceededError, () => {
    return applicationError('workspace.quota_exceeded');
  }),
  errorRegistration(ArtifactUploadIdempotencyConflictError, () => {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }),
  errorRegistration(ArtifactUploadNotFoundError, () =>
    applicationError('resource.not_found'),
  ),
  ...[
    ArtifactApiConflictError,
    ArtifactUploadDeadlineError,
    ArtifactUploadConflictError,
    ArtifactIntegrityError,
    ArtifactNotFoundError,
  ].map((kind) =>
    errorRegistration(kind, () =>
      applicationError('artifact.conflict', {
        safeDetail: 'The artifact conflicts with its current lifecycle state.',
      }),
    ),
  ),
  errorRegistration(ArtifactApiUnavailableError, (error) => {
    return applicationError('artifact.unavailable', {
      safeDetail: 'Artifact storage is temporarily unavailable.',
      cause: error,
    });
  }),
];
