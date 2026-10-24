import { z } from 'zod';
import type { artifacts } from '../schema.js';

import {
  artifactByteLengthSchema,
  artifactMediaTypeSchema,
  artifactSha256Schema,
} from './metadata/contract.js';

export const ARTIFACT_STATUS = {
  available: 'available',
  deleted: 'deleted',
  deleting: 'deleting',
  pending: 'pending',
} as const;

export type ArtifactStatus =
  (typeof ARTIFACT_STATUS)[keyof typeof ARTIFACT_STATUS];

export type ArtifactRecord = typeof artifacts.$inferSelect;

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

export type CreatePendingArtifactInput = z.input<typeof pendingArtifactSchema>;

export type CreatePendingPreviewArtifactInput = z.input<
  typeof pendingPreviewArtifactSchema
>;

export type FinalizeArtifactInput = z.input<typeof finalizeArtifactSchema>;

export type ClaimDueUnfinalizedArtifactsInput = z.input<
  typeof claimInputSchema
>;

export type ClaimDueUnfinalizedArtifactInput = z.input<
  typeof claimOneInputSchema
>;

export type CompleteArtifactRemovalInput = z.input<typeof removalInputSchema>;

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
