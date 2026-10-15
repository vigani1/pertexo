import { z } from 'zod';
import {
  ARTIFACT_INPUT_MAX_BYTES,
  nodeArtifactReferenceSchema,
} from '@pertexo/node-sdk';

export const HTTP_MULTIPART_MAX_PARTS = 64;

function noControls(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && (code < 127 || code > 159);
  });
}
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const httpMultipartInputKeySchema = z
  .string()
  .regex(
    /^part_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const nameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(noControls, 'Do not use control characters')
  .refine((value) => bytes(value) <= 128);
const filenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(noControls, 'Do not use control characters')
  .refine(
    (value) =>
      bytes(value) <= 255 &&
      !/[\\/]/u.test(value) &&
      value !== '.' &&
      value !== '..',
  );
const contentTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:;[\x20-\x7e]*)?$/u,
  );
export const httpMultipartPartSchema = z
  .object({
    inputKey: httpMultipartInputKeySchema,
    name: nameSchema,
    kind: z.enum(['text', 'file']),
    filename: filenameSchema.optional(),
    contentType: contentTypeSchema.optional(),
  })
  .strict();
export const httpMultipartConfigSchema = z
  .object({
    parts: z
      .array(httpMultipartPartSchema)
      .min(1)
      .max(HTTP_MULTIPART_MAX_PARTS),
  })
  .strict()
  .refine(
    ({ parts }) =>
      new Set(parts.map((part) => part.inputKey)).size === parts.length,
    'Each multipart part needs its own input key',
  );
export const httpMultipartFileSchema = nodeArtifactReferenceSchema
  .unwrap()
  .extend({
    kind: z.literal('artifact'),
    byteLength: z.number().int().min(0).max(ARTIFACT_INPUT_MAX_BYTES),
  })
  .strict();
export const httpMultipartValueSchema = z.union([
  z.string().max(ARTIFACT_INPUT_MAX_BYTES),
  httpMultipartFileSchema,
]);
export type HttpMultipartConfig = z.output<typeof httpMultipartConfigSchema>;
export type HttpMultipartPart = z.output<typeof httpMultipartPartSchema>;
export type HttpMultipartFile = z.output<typeof httpMultipartFileSchema>;
