import { WORKFLOW_FOLDER_LIMITS } from '@pertexo/workflow-model';
import { utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';

const uuid = z.uuid().overwrite((value) => value.toLowerCase());

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// C0 controls and DEL, which a stored folder name never holds.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

const canonicalName = z
  .string()
  .min(1)
  .max(WORKFLOW_FOLDER_LIMITS.nameBytes)
  .refine(
    (value) =>
      value === value.replace(/^ +| +$(?![\s\S])/gu, '') &&
      utf8ByteLength(value) >= 1 &&
      utf8ByteLength(value) <= WORKFLOW_FOLDER_LIMITS.nameBytes &&
      !CONTROL_CHARACTER.test(value),
  );

const folder = z
  .object({
    id: uuid,
    name: canonicalName,
    parentId: uuid.nullable(),
    revision,
    depth: z.number().int().min(1).max(WORKFLOW_FOLDER_LIMITS.depth),
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
