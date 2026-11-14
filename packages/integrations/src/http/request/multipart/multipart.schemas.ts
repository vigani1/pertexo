import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';
import {
  ARTIFACT_INPUT_MAX_BYTES,
  nodeArtifactReferenceSchema,
} from '@pertexo/node-sdk';

export const HTTP_MULTIPART_MAX_PARTS = 64;
const MULTIPART_FIELD_LIMITS = Object.freeze({
  nameBytes: 128,
  filenameBytes: 255,
  // `a/b` is the shortest media type.
  minimumContentTypeCharacters: 3,
  contentTypeCharacters: 255,
});
// C0 controls end at 0x1f; DEL and the C1 controls run from 0x7f to 0x9f.
const CONTROL_CODES = Object.freeze({
  firstPrintable: 0x20,
  del: 0x7f,
  lastC1: 0x9f,
});

function noControls(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return (
      code >= CONTROL_CODES.firstPrintable &&
      (code < CONTROL_CODES.del || code > CONTROL_CODES.lastC1)
    );
  });
}
export const httpMultipartInputKeySchema = z
  .string()
  .regex(
    /^part_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const nameSchema = z
  .string()
  .min(1)
  .max(MULTIPART_FIELD_LIMITS.nameBytes)
  .refine(noControls, 'Do not use control characters')
  .refine((value) => utf8ByteLength(value) <= MULTIPART_FIELD_LIMITS.nameBytes);
const filenameSchema = z
  .string()
  .min(1)
  .max(MULTIPART_FIELD_LIMITS.filenameBytes)
  .refine(noControls, 'Do not use control characters')
  .refine(
    (value) =>
      utf8ByteLength(value) <= MULTIPART_FIELD_LIMITS.filenameBytes &&
      !/[\\/]/u.test(value) &&
      value !== '.' &&
      value !== '..',
  );
const contentTypeSchema = z
  .string()
  .min(MULTIPART_FIELD_LIMITS.minimumContentTypeCharacters)
  .max(MULTIPART_FIELD_LIMITS.contentTypeCharacters)
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
  })
  .strict();
export const httpMultipartValueSchema = z.union([
  z.string().max(ARTIFACT_INPUT_MAX_BYTES),
  httpMultipartFileSchema,
]);
export type HttpMultipartConfig = z.output<typeof httpMultipartConfigSchema>;
export type HttpMultipartPart = z.output<typeof httpMultipartPartSchema>;
export type HttpMultipartFile = z.output<typeof httpMultipartFileSchema>;
