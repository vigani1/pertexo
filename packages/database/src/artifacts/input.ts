import { z } from 'zod';

import {
  artifactByteLengthSchema,
  artifactMediaTypeSchema,
  artifactSha256Schema,
} from './metadata/validation.js';

export const ARTIFACT_STATUS = {
  available: 'available',
  deleted: 'deleted',
  deleting: 'deleting',
  pending: 'pending',
} as const;

const metadataSchema = z.object({
  artifactId: z.uuid(),
  byteLength: artifactByteLengthSchema,
  mediaType: artifactMediaTypeSchema,
  sha256: artifactSha256Schema,
  storageKey: z.string().min(1).max(512),
});

export const pendingArtifactSchema = metadataSchema.extend({
  expiresAt: z.date(),
  purpose: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]{0,63}$/u),
});

export const pendingPreviewArtifactSchema = pendingArtifactSchema.extend({
  previewRunId: z.uuid(),
});

export const finalizeArtifactSchema = metadataSchema.extend({
  workspaceId: z.uuid(),
});

export const claimInputSchema = z.object({
  limit: z.number().int().min(1).max(100),
});

export const claimOneInputSchema = z.object({ artifactId: z.uuid() });

export const removalInputSchema = z.object({ artifactId: z.uuid() });

export class ArtifactFinalizeConflictError extends Error {
  public constructor() {
    super('Validated object metadata does not match the pending artifact');
    this.name = 'ArtifactFinalizeConflictError';
  }
}

export class ArtifactLifecycleConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ArtifactLifecycleConflictError';
  }
}

export class ArtifactMetadataNotFoundError extends Error {
  public constructor() {
    super('Artifact metadata was not found in the workspace');
    this.name = 'ArtifactMetadataNotFoundError';
  }
}
