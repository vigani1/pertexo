import { z } from 'zod';
import { normalizeJson } from '@pertexo/workflow-model';

export const executableNodeSchema = z.unknown().transform((value, context) => {
  try {
    const admitted = normalizeJson(value);
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
    const node = JSON.parse(serialized) as Readonly<Record<string, unknown>>;
    const connectionRefs = z
      .record(z.string(), z.string())
      .optional()
      .parse(node.connectionRefs);
    return {
      ...node,
      ...(connectionRefs === undefined ? {} : { connectionRefs }),
    };
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'executable node must be a bounded JSON object',
    });
    return z.NEVER;
  }
});
