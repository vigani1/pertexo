import { z } from 'zod';
import { FILE_PAGE_LIMITS } from '../page-limits.js';
import { nodeArtifactReferenceSchema } from '../reference.js';

export const filePageReferenceSchema = nodeArtifactReferenceSchema
  .unwrap()
  .extend({
    kind: z.literal('artifact'),
    byteLength: z.number().int().min(2).max(FILE_PAGE_LIMITS.bytes),
  })
  .strict()
  .readonly();
export const filePageBundleSchema = z
  .object({
    pages: z
      .array(filePageReferenceSchema)
      .max(FILE_PAGE_LIMITS.pages)
      .readonly(),
    itemCount: z.number().int().min(0).max(FILE_PAGE_LIMITS.totalItems),
    pageCount: z.number().int().min(0).max(FILE_PAGE_LIMITS.pages),
  })
  .strict()
  .refine(
    (bundle) => bundle.pages.length === bundle.pageCount,
    'Page count must match the file references',
  )
  .readonly();
export type FilePageBundle = z.output<typeof filePageBundleSchema>;
