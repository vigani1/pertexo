import { z } from 'zod';

export const WORKFLOW_INPUT_CASE_MAX_BYTES = 65_536;
export const WORKFLOW_INPUT_CASE_MAX_DEPTH = 64;
export const WORKFLOW_INPUT_CASE_MAX_MEMBERS = 10_000;

function supportedString(value: string): boolean {
  return (
    !value.includes('\u0000') &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  );
}

/** Inspect descriptors before recursive JSON parsing; never invoke input accessors. */
function boundedCaseJson(value: unknown): boolean {
  let members = 0;
  const ancestors = new Set<object>();
  function normalize(current: unknown, depth: number): unknown {
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      if (!supportedString(current)) throw new TypeError();
      return current;
    }
    if (typeof current === 'number' && Number.isFinite(current))
      return Object.is(current, -0) ? 0 : current;
    if (typeof current !== 'object' || ancestors.has(current))
      throw new TypeError();
    if (
      depth === WORKFLOW_INPUT_CASE_MAX_DEPTH ||
      Object.getOwnPropertySymbols(current).length > 0
    )
      throw new TypeError();
    const array = Array.isArray(current);
    if (array && current.length > WORKFLOW_INPUT_CASE_MAX_MEMBERS)
      throw new TypeError();
    if (
      !array &&
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    )
      throw new TypeError();
    const keys = array
      ? Array.from({ length: current.length }, (_, index) => String(index))
      : Object.keys(current).sort();
    if (array && Object.getOwnPropertyNames(current).length !== keys.length + 1)
      throw new TypeError();
    members += keys.length;
    if (members > WORKFLOW_INPUT_CASE_MAX_MEMBERS) throw new TypeError();
    ancestors.add(current);
    try {
      const normalized: Record<string, unknown> | unknown[] = array
        ? []
        : (Object.create(null) as Record<string, unknown>);
      for (const key of keys) {
        if (!supportedString(key)) throw new TypeError();
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !('value' in descriptor))
          throw new TypeError();
        Object.defineProperty(normalized, key, {
          value: normalize(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  }
  try {
    const text = JSON.stringify(normalize(value, 0));
    let bytes = 0;
    // Shared browser/server contract: no Node Buffer or DOM runtime dependency.
    for (const character of text) {
      const point = character.charCodeAt(0);
      bytes +=
        character.length === 2 ? 4 : point <= 0x7f ? 1 : point <= 0x7ff ? 2 : 3;
      if (bytes > WORKFLOW_INPUT_CASE_MAX_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const workflowInputCaseJsonSchema = z
  .any()
  .superRefine((value, context) => {
    if (!boundedCaseJson(value))
      context.addIssue({
        code: 'custom',
        message:
          'Run-input case must be ordinary JSON within 64 KiB, depth 64 and 10,000 members.',
      });
  })
  .pipe(z.json())
  .meta({
    description:
      'Manually entered JSON; bounded validation does not guarantee acceptance by workflow nodes or providers.',
    'x-pertexo-runtime-max-bytes': WORKFLOW_INPUT_CASE_MAX_BYTES,
    'x-pertexo-runtime-max-depth': WORKFLOW_INPUT_CASE_MAX_DEPTH,
    'x-pertexo-runtime-max-members': WORKFLOW_INPUT_CASE_MAX_MEMBERS,
  });

export const workflowInputCaseRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647);
export const workflowInputCaseTagSchema = z
  .string()
  .regex(/^"wic1\.[0-9a-f]{32}\.[0-9a-z]{1,6}"$/u);

/** Clients must treat this strong representation validator as opaque. */
export function createWorkflowInputCaseTag(
  caseId: string,
  revision: number,
): string {
  const id = z.uuid().parse(caseId).replaceAll('-', '').toLowerCase();
  return `"wic1.${id}.${workflowInputCaseRevisionSchema.parse(revision).toString(36)}"`;
}
export function parseWorkflowInputCaseTag(
  value: unknown,
): Readonly<{ caseId: string; revision: number }> | undefined {
  const parsed = workflowInputCaseTagSchema.safeParse(value);
  if (!parsed.success) return undefined;
  // The strict tag grammar fixes the 32-character ID and both separators.
  const id = parsed.data.slice(6, 38);
  const revisionPart = parsed.data.slice(39, -1);
  const revision = Number.parseInt(revisionPart, 36);
  if (
    !workflowInputCaseRevisionSchema.safeParse(revision).success ||
    revision.toString(36) !== revisionPart
  )
    return undefined;
  const caseId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  if (!z.uuid().safeParse(caseId).success) return undefined;
  return { caseId, revision };
}

export const workflowInputCaseNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(supportedString, 'Case names must contain supported Unicode text');
export const workflowInputCaseMetadataSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    workflowVersionId: z.uuid(),
    versionChecksum: z.string().regex(/^wf:v2:sha256:[0-9a-f]{64}$/u),
    name: workflowInputCaseNameSchema,
    revision: workflowInputCaseRevisionSchema,
    representationTag: workflowInputCaseTagSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const workflowInputCaseSchema = workflowInputCaseMetadataSchema
  .extend({ input: workflowInputCaseJsonSchema })
  .strict();
export const workflowInputCaseResponseSchema = z
  .object({ case: workflowInputCaseSchema })
  .strict();
export const workflowInputCaseListResponseSchema = z
  .object({
    items: z.array(workflowInputCaseMetadataSchema).max(100),
    nextCursor: z.string().min(1).max(1_024).optional(),
  })
  .strict();
export const workflowInputCaseQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    after: z.string().min(1).max(1_024).optional(),
  })
  .strict();
export const workflowInputCaseParamSchema = z
  .object({ workspaceId: z.uuid(), workflowId: z.uuid(), caseId: z.uuid() })
  .strict();
export const workflowInputCaseCreateRequestSchema = z
  .object({
    workflowVersionId: z.uuid(),
    name: workflowInputCaseNameSchema,
    input: workflowInputCaseJsonSchema,
  })
  .strict();
export const workflowInputCaseUpdateRequestSchema = z
  .object({
    name: workflowInputCaseNameSchema,
    input: workflowInputCaseJsonSchema,
  })
  .strict();
export const workflowInputCaseCommandResponseSchema = z
  .object({
    caseId: z.uuid(),
    revision: workflowInputCaseRevisionSchema,
    replayed: z.boolean(),
  })
  .strict();

export type WorkflowInputCaseMetadata = z.output<
  typeof workflowInputCaseMetadataSchema
>;
export type WorkflowInputCase = z.output<typeof workflowInputCaseSchema>;
export type WorkflowInputCaseResponse = z.output<
  typeof workflowInputCaseResponseSchema
>;
export type WorkflowInputCaseListResponse = z.output<
  typeof workflowInputCaseListResponseSchema
>;
export type WorkflowInputCaseCreateRequest = z.output<
  typeof workflowInputCaseCreateRequestSchema
>;
export type WorkflowInputCaseUpdateRequest = z.output<
  typeof workflowInputCaseUpdateRequestSchema
>;
export type WorkflowInputCaseCommandResponse = z.output<
  typeof workflowInputCaseCommandResponseSchema
>;
