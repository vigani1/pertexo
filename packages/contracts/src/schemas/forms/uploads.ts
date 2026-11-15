import { FORM_FILE_LIMITS, FORM_LIMITS } from '@pertexo/workflow-model';
import { responseSchema } from '../shared/response-schema.js';
import { storageTextSchema } from '@pertexo/workflow-model';
import { z } from 'zod';
import { artifactUploadResponseSchema } from '../execution/artifact-transfer.js';

const UPLOADS_BOUNDS = Object.freeze({
  fieldIdCharacters: FORM_LIMITS.fieldIdCharacters,
  filenameCharacters: 1024,
  mediaTypeMinimumCharacters: 3,
  mediaTypeCharacters: FORM_FILE_LIMITS.mediaTypeCharacters,
});

/** A responder's random token for one response; only its digest is stored. */
export const formUploadSessionSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const formUploadRequestSchema = z
  .object({
    versionId: z.uuid(),
    fieldId: z.string().min(1).max(UPLOADS_BOUNDS.fieldIdCharacters),
    filename: storageTextSchema
      .trim()
      .min(1)
      .max(UPLOADS_BOUNDS.filenameCharacters),
    byteLength: z.number().int().min(0).max(FORM_FILE_LIMITS.maxBytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const taskUploadRequestSchema = formUploadRequestSchema
  .omit({ versionId: true })
  .strict();
export const formFinalizeUploadRequestSchema = z.object({}).strict();
export const publicFormUploadParamsSchema = z
  .object({ publicId: z.uuid(), uploadId: z.uuid() })
  .strict();
export const memberFormUploadParamsSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid(), uploadId: z.uuid() })
  .strict();
export const taskUploadsParamsSchema = z
  .object({ workspaceId: z.uuid(), taskId: z.uuid() })
  .strict();
export const taskUploadParamsSchema = taskUploadsParamsSchema
  .extend({ uploadId: z.uuid() })
  .strict();
export const formUploadSchema = responseSchema(
  z
    .object({
      id: z.uuid(),
      filename: z.string().min(1).max(FORM_FILE_LIMITS.filenameCharacters),
      byteLength: z.number().int().min(0).max(FORM_FILE_LIMITS.maxBytes),
      mediaType: z
        .string()
        .min(UPLOADS_BOUNDS.mediaTypeMinimumCharacters)
        .max(UPLOADS_BOUNDS.mediaTypeCharacters),
      status: z.enum(['pending', 'available']),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
);
export const formUploadResponseSchema = responseSchema(
  z
    .object({
      upload: formUploadSchema
        .extend({ status: z.literal('pending') })
        .strict(),
      transfer: artifactUploadResponseSchema.shape.upload,
      replayed: z.boolean(),
    })
    .strict(),
);
export type FormUploadMetadata = z.output<typeof formUploadSchema>;
export type FormUploadResponse = z.output<typeof formUploadResponseSchema>;
