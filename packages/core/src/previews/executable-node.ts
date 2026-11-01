import { normalizeJson, utf8ByteLength } from '@pertexo/workflow-model';
import { z } from 'zod';

const EXECUTABLE_NODE_MAX_BYTES = 1_048_576;

export const executableNodeSchema = z.unknown().transform((value, context) => {
  try {
    const admitted = normalizeJson(value);
    const invalidExecutable =
      admitted === null ||
      typeof admitted !== 'object' ||
      Array.isArray(admitted);
    if (invalidExecutable)
      throw new TypeError('executable node must be a bounded JSON object');
    const serialized = JSON.stringify(admitted);
    if (utf8ByteLength(serialized) > EXECUTABLE_NODE_MAX_BYTES)
      throw new TypeError('executable node must be a bounded JSON object');
    // Drizzle inspects the root object's constructor. Materialize the admitted
    // descriptor snapshot as ordinary JSON instead of exposing its null-
    // prototype normalization object to the adapter.
    const node = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(serialized));
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
