import { z } from 'zod';

export const uuid = z.uuid().overwrite((value) => value.toLowerCase());

export const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const canonicalKey = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u);

export const key = z
  .string()
  .overwrite((value) =>
    value
      .replace(/^ +| +$(?![\s\S])/gu, '')
      .replace(/[A-Z]/gu, (letter) => letter.toLowerCase()),
  )
  .pipe(canonicalKey);

const tag = z.object({ id: uuid, key: canonicalKey, revision }).strict();

export const assignment = z
  .object({ workflowId: uuid, organizationRevision: revision })
  .strict();

export const tagResult = z.object({ tag }).strict();

export const deleteResult = z
  .object({
    tagId: uuid,
    deleted: z.literal(true),
    detachedWorkflowCount: z
      .number()
      .int()
      .min(0)
      .max(TAG_DELETE_WORKFLOW_LIMIT),
  })
  .strict();

export const tagIds = z
  .array(uuid)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length)
  .overwrite((ids) => [...ids].sort());

export const replaceResult = assignment.extend({ tagIds }).strict();

import { TAG_DELETE_WORKFLOW_LIMIT } from '../limits.js';
