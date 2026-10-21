import { z } from 'zod';
import {
  canonicalJson,
  canonicalizeJson,
  inspectJsonValue,
  type JsonValue,
} from '../../values/json/canonical.js';
import { parseJsonPath } from '../../values/json/path.js';
import { isStorageText } from '../../values/json/text.js';

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
      if (
        inspected.bytes <= 4096 &&
        inspected.depth <= 64 &&
        inspected.members <= 10000 &&
        validText(canonicalizeJson(value))
      )
        return;
    } catch {
      /* Invalid JSON is rejected at this boundary. */
    }
    context.addIssue({
      code: 'custom',
      message:
        'Expected value must be ordinary JSON within 4 KiB, depth 64 and 10,000 members.',
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
          nodeId: z.string().min(1).max(256).refine(isStorageText),
        })
        .strict(),
    ]),
    path: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => {
        const segments = parseJsonPath(value);
        return (
          segments !== undefined &&
          segments.length <= 64 &&
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
      .max(20)
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
      new TextEncoder().encode(canonicalJson(value)).byteLength <= 16384,
    'Expectations must fit within 16 KiB per case.',
  );
export const DEFAULT_TEST_EXPECTATIONS: WorkflowTestExpectations =
  Object.freeze({ outcome: 'succeeds', assertions: Object.freeze([]) });
export type WorkflowTestExpectations = Readonly<{
  outcome: 'succeeds' | 'fails';
  assertions: readonly z.output<typeof testAssertionSchema>[];
}>;
export type TestAssertion = z.output<typeof testAssertionSchema>;
