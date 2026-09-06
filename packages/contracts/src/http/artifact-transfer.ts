import { z } from 'zod';

const artifactByteLengthSchema = z
  .number()
  .int()
  .min(0)
  .max(5 * 1024 * 1024 * 1024);
const artifactMediaTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^[^\s/;]+\/[^\r\n]+$/u);
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
export const artifactMetadataResponseSchema = z
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
  .strict();

export const artifactUploadResponseSchema = z
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
        expiresInSeconds: z.number().int().min(60).max(900),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();
export const artifactDownloadResponseSchema = z
  .object({
    method: z.literal('GET'),
    url: z.url(),
    expiresAt: z.iso.datetime(),
    expiresInSeconds: z.number().int().min(60).max(900),
  })
  .strict();

export type ArtifactUploadRequest = z.output<
  typeof artifactUploadRequestSchema
>;
export type ArtifactMetadataResponse = z.output<
  typeof artifactMetadataResponseSchema
>;
export type ArtifactUploadResponse = z.output<
  typeof artifactUploadResponseSchema
>;
export type ArtifactDownloadResponse = z.output<
  typeof artifactDownloadResponseSchema
>;
