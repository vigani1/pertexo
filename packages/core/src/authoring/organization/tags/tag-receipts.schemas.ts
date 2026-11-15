import { WORKFLOW_ORGANIZATION_LIMITS } from '@pertexo/workflow-model';
import { z } from 'zod';

const uuid = z.uuid().overwrite((value) => value.toLowerCase());

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const canonicalKey = z
  .string()
  .min(1)
  .max(WORKFLOW_ORGANIZATION_LIMITS.tagKeyBytes)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u);

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
      .max(WORKFLOW_ORGANIZATION_LIMITS.cleanupItems),
  })
  .strict();

const tagIds = z
  .array(uuid)
  .max(WORKFLOW_ORGANIZATION_LIMITS.tagsPerWorkflow)
  .refine((ids) => new Set(ids).size === ids.length)
  .overwrite((ids) => [...ids].sort());

export const replaceResult = assignment.extend({ tagIds }).strict();
