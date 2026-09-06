import { z } from 'zod';

import {
  applicationError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { AuthorizationError } from '../workspaces/index.js';

export class ArtifactApiNotFoundError extends Error {
  public constructor() {
    super('Artifact was not found');
    this.name = 'ArtifactApiNotFoundError';
  }
}
export class ArtifactApiConflictError extends Error {
  public constructor(message = 'Artifact conflicts with its current state') {
    super(message);
    this.name = 'ArtifactApiConflictError';
  }
}
export class ArtifactApiIdempotencyConflictError extends Error {
  public constructor() {
    super('The idempotency key was already used for another artifact request');
    this.name = 'ArtifactApiIdempotencyConflictError';
  }
}
export class ArtifactApiCapacityExceededError extends Error {
  public constructor() {
    super('Workspace artifact capacity was exceeded');
    this.name = 'ArtifactApiCapacityExceededError';
  }
}
export class ArtifactApiUnavailableError extends Error {
  public constructor(message = 'Artifact storage is unavailable') {
    super(message);
    this.name = 'ArtifactApiUnavailableError';
  }
}
export class ArtifactUploadDeadlineError extends Error {
  public constructor() {
    super('Artifact upload deadline has passed');
    this.name = 'ArtifactUploadDeadlineError';
  }
}
export class ArtifactUploadTooLargeError extends Error {
  public constructor() {
    super('Artifact exceeds the configured object size limit');
    this.name = 'ArtifactUploadTooLargeError';
  }
}

export function mapArtifactError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (
    error instanceof z.ZodError ||
    error instanceof ArtifactUploadTooLargeError
  )
    return applicationError('request.invalid', {
      safeDetail: 'The artifact request is invalid.',
    });
  if (error instanceof AuthorizationError)
    return applicationError(error.code, { safeDetail: error.message });
  if (error instanceof ArtifactApiNotFoundError)
    return applicationError('resource.not_found');
  if (error instanceof ArtifactApiCapacityExceededError)
    return applicationError('workspace.quota_exceeded');
  if (error instanceof ArtifactApiIdempotencyConflictError)
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  if (
    error instanceof ArtifactApiConflictError ||
    error instanceof ArtifactUploadDeadlineError
  )
    return applicationError('artifact.conflict', {
      safeDetail: 'The artifact conflicts with its current lifecycle state.',
    });
  if (error instanceof ArtifactApiUnavailableError)
    return applicationError('artifact.unavailable', {
      safeDetail: 'Artifact storage is temporarily unavailable.',
      cause: error,
    });

  return applicationError('internal.unexpected', { cause: error });
}
