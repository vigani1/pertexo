import { z } from 'zod';
import { storedExecutionJsonStringBytes } from '../values/stored-json.js';

export const RUN_VALUE_LIMITS = Object.freeze({
  pairs: 10,
  keyCharacters: 50,
  valueCharacters: 255,
});
export const runValueKeySchema = z
  .string()
  .min(1)
  .max(RUN_VALUE_LIMITS.keyCharacters)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u,
    'Use letters, numbers, underscores, dots and hyphens, starting with a letter or number.',
  );
export const runValueTextSchema = z
  .string()
  .max(RUN_VALUE_LIMITS.valueCharacters)
  .refine((value) => {
    try {
      storedExecutionJsonStringBytes(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use valid text without NUL characters.');
export const runValuesSchema = z
  .record(runValueKeySchema, runValueTextSchema)
  .refine(
    (values) => Object.keys(values).length <= RUN_VALUE_LIMITS.pairs,
    'Save at most ten run values.',
  );
export type RunValues = Readonly<z.output<typeof runValuesSchema>>;
export const saveRunValuesInputSchema = z
  .object({
    values: runValuesSchema.refine(
      (values) => Object.keys(values).length > 0,
      'Add at least one run value.',
    ),
  })
  .strict();
export const saveRunValuesOutputSchema = z
  .object({ values: runValuesSchema })
  .strict();
export interface NodeRunValuesRuntime {
  save(
    input: Readonly<{ values: RunValues; signal: AbortSignal }>,
  ): Promise<RunValues>;
}
