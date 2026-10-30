import {
  CANONICAL_JSON_MAX_DEPTH,
  normalizedJson,
} from '@pertexo/workflow-model';
import { z } from 'zod';

/** The server's own JSON admission, so a browser preflight can't drift from it. */
function isCanonicalJson(value: unknown): boolean {
  try {
    normalizedJson(value);
    return true;
  } catch {
    // Anything it can't read, a hostile value included, isn't ordinary JSON.
    return false;
  }
}

export const boundedNodeTestJsonInputSchema = z
  .any()
  .superRefine((value, context) => {
    if (!isCanonicalJson(value))
      context.addIssue({
        code: 'custom',
        message: `JSON input must be ordinary JSON within depth ${String(CANONICAL_JSON_MAX_DEPTH)}`,
      });
  })
  .pipe(z.json())
  .meta({
    description: `JSON input. Runtime validation rejects values deeper than ${String(CANONICAL_JSON_MAX_DEPTH)} containers before recursive schema parsing.`,
    'x-pertexo-runtime-max-depth': CANONICAL_JSON_MAX_DEPTH,
  });
