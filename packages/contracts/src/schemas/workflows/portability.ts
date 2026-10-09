import { z } from 'zod';
import { workflowTemplateOriginRequestSchema } from '@pertexo/templates';
import {
  portableConnectionBindingSchema,
  portableConnectionSlotSchema,
  portableIssueSchema,
  WORKFLOW_PORTABILITY_LIMITS,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';

const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('draft') }).strict(),
  z.object({ kind: z.literal('version'), versionId: z.uuid() }).strict(),
]);
const bindings = z
  .array(portableConnectionBindingSchema)
  .max(WORKFLOW_PORTABILITY_LIMITS.connectionSlots);
export const workflowExportRequestSchema = z
  .object({
    source,
    reviewedGraphDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const workflowImportPreviewRequestSchema = z
  .object({
    manifest: workflowPortableManifestSchema,
    bindings,
    templateOrigin: workflowTemplateOriginRequestSchema.optional(),
  })
  .strict();
export const workflowImportRequestSchema =
  workflowImportPreviewRequestSchema.extend({
    name: z.string().trim().min(1).max(128),
    expectedCompatibilityFingerprint: z
      .string()
      .regex(/^wf-compat:v1:sha256:[a-f0-9]{64}$/u),
  });
export const workflowImportPreviewResponseSchema = z
  .object({
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    compatibilityFingerprint: z
      .string()
      .regex(/^wf-compat:v1:sha256:[a-f0-9]{64}$/u),
    compatible: z.boolean(),
    issues: z
      .array(portableIssueSchema)
      .max(WORKFLOW_PORTABILITY_LIMITS.issues),
    truncated: z.boolean(),
    connectionSlots: z
      .array(portableConnectionSlotSchema)
      .max(WORKFLOW_PORTABILITY_LIMITS.connectionSlots),
  })
  .strict();
export const workflowImportResponseSchema = z
  .object({ workflowId: z.uuid() })
  .strict();
export type WorkflowExportRequest = z.infer<typeof workflowExportRequestSchema>;
export type WorkflowImportPreviewRequest = z.infer<
  typeof workflowImportPreviewRequestSchema
>;
export type WorkflowImportRequest = z.infer<typeof workflowImportRequestSchema>;
export type WorkflowImportPreviewResponse = z.infer<
  typeof workflowImportPreviewResponseSchema
>;
