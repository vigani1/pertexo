import { responseSchema } from '../shared/response-schema.js';
import { z } from 'zod';

import { isSupportedHttpFieldValue } from '../shared/http-field-value.js';

/** The largest artifact the API stores; an operator may configure a lower one. */
export const ARTIFACT_OBJECT_MAX_BYTES = 10 * 1024 * 1024;

const ARTIFACT_TRANSFER_BOUNDS = Object.freeze({
  artifactMediaTypeMinimumCharacters: 3,
  artifactMediaTypeCharacters: 255,
  expiresInSecondsMinimum: 60,
  expiresInSecondsMaximum: 900,
  artifactBytes: 5 * 1024 * 1024 * 1024,
});

const artifactByteLengthSchema = z
  .number()
  .int()
  .min(0)
  .max(ARTIFACT_TRANSFER_BOUNDS.artifactBytes);
const artifactMediaTypeSchema = z
  .string()
  .trim()
  .min(ARTIFACT_TRANSFER_BOUNDS.artifactMediaTypeMinimumCharacters)
  .max(ARTIFACT_TRANSFER_BOUNDS.artifactMediaTypeCharacters)
  .regex(/^[^\s/;]+\/[^\r\n]+$/u)
  .refine(isSupportedHttpFieldValue, {
    message: 'Media type contains an unsupported HTTP field value',
  });
const artifactSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const artifactUploadRequestSchema = z
  .object({
    byteLength: artifactByteLengthSchema,
    mediaType: artifactMediaTypeSchema,
    sha256: artifactSha256Schema,
  })
  .strict();
export const artifactFinalizeRequestSchema = z.object({}).strict();
export const artifactWorkspaceParamsSchema = z
  .object({ workspaceId: z.uuid() })
  .strict();
export const artifactParamsSchema = artifactWorkspaceParamsSchema
  .extend({ artifactId: z.uuid() })
  .strict();
export const artifactMetadataResponseSchema = responseSchema(
  z
    .object({
      id: z.uuid(),
      workspaceId: z.uuid(),
      byteLength: artifactByteLengthSchema,
      mediaType: artifactMediaTypeSchema,
      sha256: artifactSha256Schema,
      status: z.enum(['pending', 'available']),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
    })
    .strict(),
);

export const artifactUploadResponseSchema = responseSchema(
  z
    .object({
      artifact: artifactMetadataResponseSchema.extend({
        status: z.literal('pending'),
        expiresAt: z.iso.datetime(),
      }),
      upload: z
        .object({
          method: z.literal('PUT'),
          url: z.url(),
          headers: z.record(z.string(), z.string()),
          expiresAt: z.iso.datetime(),
          expiresInSeconds: z
            .number()
            .int()
            .min(ARTIFACT_TRANSFER_BOUNDS.expiresInSecondsMinimum)
            .max(ARTIFACT_TRANSFER_BOUNDS.expiresInSecondsMaximum),
        })
        .strict(),
      replayed: z.boolean(),
    })
    .strict(),
);
export const artifactDownloadResponseSchema = responseSchema(
  z
    .object({
      method: z.literal('GET'),
      url: z.url(),
      expiresAt: z.iso.datetime(),
      expiresInSeconds: z
        .number()
        .int()
        .min(ARTIFACT_TRANSFER_BOUNDS.expiresInSecondsMinimum)
        .max(ARTIFACT_TRANSFER_BOUNDS.expiresInSecondsMaximum),
    })
    .strict(),
);

export type ArtifactMetadataResponse = z.output<
  typeof artifactMetadataResponseSchema
>;
export type ArtifactUploadResponse = z.output<
  typeof artifactUploadResponseSchema
>;
export type ArtifactDownloadResponse = z.output<
  typeof artifactDownloadResponseSchema
>;

export type ArtifactUploadRequest = z.output<
  typeof artifactUploadRequestSchema
>;
