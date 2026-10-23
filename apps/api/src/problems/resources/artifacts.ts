import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  ArtifactUploadTooLargeError,
  ArtifactApiNotFoundError,
  ArtifactApiCapacityExceededError,
  ArtifactApiIdempotencyConflictError,
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
  errorRegistration(ArtifactApiCapacityExceededError, () => {
    return applicationError('workspace.quota_exceeded');
  }),
  errorRegistration(ArtifactApiIdempotencyConflictError, () => {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }),
  errorRegistration(ArtifactApiConflictError, () => {
    return applicationError('artifact.conflict', {
      safeDetail: 'The artifact conflicts with its current lifecycle state.',
    });
  }),
  errorRegistration(ArtifactUploadDeadlineError, () => {
    return applicationError('artifact.conflict', {
      safeDetail: 'The artifact conflicts with its current lifecycle state.',
    });
  }),
  errorRegistration(ArtifactApiUnavailableError, (error) => {
    return applicationError('artifact.unavailable', {
      safeDetail: 'Artifact storage is temporarily unavailable.',
      cause: error,
    });
  }),
];
