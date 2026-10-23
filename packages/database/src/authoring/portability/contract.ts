import { z } from 'zod';
import {
  portableConnectionBindingSchema,
  WORKFLOW_PORTABILITY_LIMITS,
  workflowPortableManifestSchema,
} from '@pertexo/workflow-model';

const scope = z.object({
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  signal: z.instanceof(AbortSignal).optional(),
  requestId: z.string().max(128).optional(),
  traceId: z.string().max(128).optional(),
});

export const previewInput = scope
  .extend({
    manifest: workflowPortableManifestSchema,
    bindings: z
      .array(portableConnectionBindingSchema)
      .max(WORKFLOW_PORTABILITY_LIMITS.connectionSlots),
  })
  .strict();

export const importInput = previewInput
  .extend({
    name: z.string().trim().min(1).max(128),
    expectedCompatibilityFingerprint: z
      .string()
      .regex(/^wf-compat:sha256:[a-f0-9]{64}$/u),
    idempotencyKey: z.string(),
    commandCredentialId: z.uuid().optional(),
  })
  .strict();

export const importResultSchema = z.object({ workflowId: z.uuid() }).strict();

export const exportInput = scope
  .extend({
    workflowId: z.uuid(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('draft') }).strict(),
      z.object({ kind: z.literal('version'), versionId: z.uuid() }).strict(),
    ]),
    reviewedGraphDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    representationTag: z
      .string()
      .regex(/^"draft\.[A-Za-z0-9_-]{43}"$/u)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.source.kind !== 'draft' || value.representationTag !== undefined,
  );
