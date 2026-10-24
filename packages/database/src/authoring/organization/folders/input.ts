import { utf8ByteLength } from '@pertexo/workflow-model';
import { FOLDER_DEPTH_LIMIT } from '../limits.js';
import { z } from 'zod';

export const uuid = z.uuid().overwrite((value) => value.toLowerCase());

export const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const canonicalName = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value === value.replace(/^ +| +$(?![\s\S])/gu, '') &&
      utf8ByteLength(value) >= 1 &&
      utf8ByteLength(value) <= 128 &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );

export const name = z
  .string()
  .overwrite((value) => value.replace(/^ +| +$(?![\s\S])/gu, ''))
  .pipe(canonicalName);

const folder = z
  .object({
    id: uuid,
    name: canonicalName,
    parentId: uuid.nullable(),
    revision,
    depth: z.number().int().min(1).max(FOLDER_DEPTH_LIMIT),
    accessMode: z.enum(['workspace', 'restricted']),
  })
  .strict()
  .refine((value) =>
    value.parentId === null ? value.depth === 1 : value.depth > 1,
  );

export const folderResult = z.object({ folder }).strict();

export const deleteResult = z
  .object({ folderId: uuid, deleted: z.literal(true) })
  .strict();

export const placementResult = z
  .object({
    workflowId: uuid,
    folderId: uuid.nullable(),
    organizationRevision: revision,
  })
  .strict();

/** Sibling names are unique regardless of ASCII letter case. */
export const nameKey = (value: string): string =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
