import type { z } from 'zod';

import type { artifacts } from '../schema.js';

import type {
  ARTIFACT_STATUS,
  pendingArtifactSchema,
  pendingPreviewArtifactSchema,
  finalizeArtifactSchema,
  claimInputSchema,
  claimOneInputSchema,
  removalInputSchema,
} from './input.js';

export type ArtifactStatus =
  (typeof ARTIFACT_STATUS)[keyof typeof ARTIFACT_STATUS];

export type ArtifactRecord = typeof artifacts.$inferSelect;

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
