// Frozen response decoders from f7372b205, packages/contracts/src/schemas/workflows/authoring.ts.
// Keep these declarations unchanged: they represent a client deployed before J4.
// Domain graph/enum imports are unchanged between that release and J4.
import { z } from 'zod';
import {
  storageTextSchema,
  workflowExecutableChecksumSchema,
  workflowGraphSchema,
  workflowActivationStatusSchema,
  workflowLifecycleStatusSchema,
} from '@pertexo/workflow-model';

const workflowIdentifierSchema = z.uuid();

const workflowLifecycleRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const workflowNameRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const workflowCursorSchema = z.string().min(1).max(512);

const workflowNameSchema = storageTextSchema.trim().min(1).max(128);

const positiveVersionSchema = z.number().int().positive();

const workflowCompatibilityIssueSchema = z
  .object({
    code: z.literal('unknown_definition'),
    definitionKey: z.string().min(1).max(256),
    version: positiveVersionSchema,
  })
  .strict();

const workflowCompatibilityReportSchema = z
  .object({
    compatible: z.boolean(),
    fingerprint: z.string().regex(/^wf-compat:sha256:[0-9a-f]{64}$/u),
    issues: z.array(workflowCompatibilityIssueSchema).max(1_000),
  })
  .strict();

const workflowSummarySchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    name: workflowNameSchema,
    nameRevision: workflowNameRevisionSchema,
    lifecycleStatus: workflowLifecycleStatusSchema,
    lifecycleRevision: workflowLifecycleRevisionSchema,
    activationStatus: workflowActivationStatusSchema,
    webhookSetupRequired: z.boolean(),
    resourceAccess: z
      .object({ canEdit: z.boolean(), canPublish: z.boolean() })
      .strict()
      .optional(),
    publishedVersionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const workflowDraftResponseSchema = z
  .object({
    workflowId: workflowIdentifierSchema,
    revision: z.number().int().positive(),
    graph: workflowGraphSchema,
    compatibility: workflowCompatibilityReportSchema,
    updatedAt: z.iso.datetime(),
  })
  .strict();

const workflowVersionResponseSchema = z
  .object({
    id: z.uuid(),
    workflowId: z.uuid(),
    versionNumber: z.number().int().positive(),
    graph: workflowGraphSchema,
    checksum: workflowExecutableChecksumSchema,
    publishedAt: z.iso.datetime(),
  })
  .strict();

const workflowListResponseSchema = z
  .object({
    items: z.array(workflowSummarySchema).max(100),
    nextCursor: workflowCursorSchema.nullable(),
  })
  .strict();

const workflowVersionsResponseSchema = z
  .object({
    items: z.array(workflowVersionResponseSchema).max(100),
    nextCursor: workflowCursorSchema.nullable(),
  })
  .strict();

export const previousResponses = {
  list: workflowListResponseSchema,
  draft: workflowDraftResponseSchema,
  versions: workflowVersionsResponseSchema,
};
