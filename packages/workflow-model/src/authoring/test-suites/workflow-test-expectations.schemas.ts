import { utf8ByteLength } from '../../values/text.js';
import { z } from 'zod';
import {
  canonicalJson,
  canonicalizeJson,
  inspectJsonValue,
  type JsonValue,
} from '../../values/json/canonical.js';
import { parseJsonPath } from '../../values/json/path.js';
import { isStorageText } from '../../values/json/text.js';
import { formatByteSize, formatCount } from '@pertexo/node-sdk';

/** Bounds on a test case's value checks, its report and the values it shows. */
export const WORKFLOW_TEST_LIMITS = Object.freeze({
  expectedValueBytes: 4_096,
  expectedValueDepth: 64,
  expectedValueMembers: 10_000,
  stepIdLength: 256,
  pathLength: 512,
  pathSegments: 64,
  assertions: 20,
  expectationsBytes: 16_384,
  // A shown value that is too large keeps this many characters.
  previewCharacters: 1_000,
  // A stored report admits previews up to this many UTF-16 units, above what
  // previewCharacters can produce.
  previewUnits: 4_000,
  stepLabelCharacters: 128,
});

function validText(value: JsonValue): boolean {
  if (typeof value === 'string') return isStorageText(value);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, item]) => isStorageText(key) && validText(item),
  );
}
export const testExpectationValueSchema: z.ZodType<JsonValue> = z
  .any()
  .superRefine((value, context) => {
    try {
      const inspected = inspectJsonValue(value);
      const withinExpectationLimits =
        inspected.bytes <= WORKFLOW_TEST_LIMITS.expectedValueBytes &&
        inspected.depth <= WORKFLOW_TEST_LIMITS.expectedValueDepth &&
        inspected.members <= WORKFLOW_TEST_LIMITS.expectedValueMembers &&
        validText(canonicalizeJson(value));
      if (withinExpectationLimits) return;
    } catch {
      /* Invalid JSON is rejected at this boundary. */
    }
    context.addIssue({
      code: 'custom',
      message: `Expected value must be ordinary JSON within ${formatByteSize(WORKFLOW_TEST_LIMITS.expectedValueBytes)}, depth ${String(WORKFLOW_TEST_LIMITS.expectedValueDepth)} and ${formatCount(WORKFLOW_TEST_LIMITS.expectedValueMembers)} members.`,
    });
  })
  .pipe(z.json());
export const testAssertionSchema = z
  .object({
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('final') }).strict(),
      z
        .object({
          kind: z.literal('step'),
          nodeId: z
            .string()
            .min(1)
            .max(WORKFLOW_TEST_LIMITS.stepIdLength)
            .refine(isStorageText),
        })
        .strict(),
    ]),
    path: z
      .string()
      .min(1)
      .max(WORKFLOW_TEST_LIMITS.pathLength)
      .refine((value) => {
        const segments = parseJsonPath(value);
        return (
          segments !== undefined &&
          segments.length <= WORKFLOW_TEST_LIMITS.pathSegments &&
          segments.every((segment) =>
            typeof segment === 'string'
              ? isStorageText(segment)
              : Number.isSafeInteger(segment),
          )
        );
      }, 'Use a JSON path such as $.total or $.items[0].name.'),
    operator: z.enum(['equals', 'contains']),
    expected: testExpectationValueSchema,
  })
  .strict();
export const workflowTestExpectationsSchema = z
  .object({
    outcome: z.enum(['succeeds', 'fails']).default('succeeds'),
    assertions: z
      .array(testAssertionSchema)
      .max(WORKFLOW_TEST_LIMITS.assertions)
      .default([])
      .refine(
        (assertions) =>
          new Set(assertions.map((assertion) => canonicalJson(assertion)))
            .size === assertions.length,
        'Remove identical duplicate value checks.',
      ),
  })
  .strict()
  .refine(
    (value) =>
      utf8ByteLength(canonicalJson(value)) <=
      WORKFLOW_TEST_LIMITS.expectationsBytes,
    `Expectations must fit within ${formatByteSize(WORKFLOW_TEST_LIMITS.expectationsBytes)} per case.`,
  );
export const DEFAULT_TEST_EXPECTATIONS: WorkflowTestExpectations =
  Object.freeze({ outcome: 'succeeds', assertions: Object.freeze([]) });
export type WorkflowTestExpectations = Readonly<{
  outcome: 'succeeds' | 'fails';
  assertions: readonly z.output<typeof testAssertionSchema>[];
}>;
export type TestAssertion = z.output<typeof testAssertionSchema>;
