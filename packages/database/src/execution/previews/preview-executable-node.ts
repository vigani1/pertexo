import { z } from 'zod';
import { canonicalizeJson } from '@pertexo/workflow-model/canonical-json';

export const executableNodeSchema = z.unknown().transform((value, context) => {
  try {
    const admitted = canonicalizeJson(value);
    if (
      admitted === null ||
      typeof admitted !== 'object' ||
      Array.isArray(admitted)
    )
      throw new TypeError('executable node must be a bounded JSON object');
    const serialized = JSON.stringify(admitted);
    if (Buffer.byteLength(serialized, 'utf8') > 1_048_576)
      throw new TypeError('executable node must be a bounded JSON object');
    // Drizzle inspects the root object's constructor. Materialize the admitted
    // descriptor snapshot as ordinary JSON instead of exposing its null-
    // prototype normalization object to the adapter.
    return JSON.parse(serialized) as Readonly<Record<string, unknown>>;
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'executable node must be a bounded JSON object',
    });
    return z.NEVER;
  }
});
