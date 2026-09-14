import { z } from 'zod';

export const NODE_TEST_JSON_MAX_DEPTH = 256;

type InspectionFrame =
  | Readonly<{ kind: 'value'; value: unknown; depth: number }>
  | Readonly<{ kind: 'leave'; value: object }>;

function hasBoundedJsonShape(value: unknown): boolean {
  const ancestors = new WeakSet<object>();
  const stack: InspectionFrame[] = [{ kind: 'value', value, depth: 0 }];

  try {
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) return false;
      if (frame.kind === 'leave') {
        ancestors.delete(frame.value);
        continue;
      }
      if (frame.depth > NODE_TEST_JSON_MAX_DEPTH) return false;

      const current = frame.value;
      if (
        current === null ||
        typeof current === 'string' ||
        typeof current === 'boolean'
      )
        continue;
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return false;
        continue;
      }
      if (typeof current !== 'object' || ancestors.has(current)) return false;

      ancestors.add(current);
      stack.push({ kind: 'leave', value: current });
      if (Array.isArray(current)) {
        if (Object.getOwnPropertySymbols(current).length > 0) return false;
        const length = current.length;
        if (Object.getOwnPropertyNames(current).length !== length + 1)
          return false;
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            current,
            String(index),
          );
          if (descriptor === undefined || !('value' in descriptor))
            return false;
          stack.push({
            kind: 'value',
            value: descriptor.value,
            depth: frame.depth + 1,
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(current).length > 0) return false;
      const keys = Object.keys(current).sort();
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !('value' in descriptor)) return false;
        stack.push({
          kind: 'value',
          value: descriptor.value,
          depth: frame.depth + 1,
        });
      }
    }
  } catch {
    return false;
  }
  return true;
}

export const boundedNodeTestJsonInputSchema = z
  .any()
  .superRefine((value, context) => {
    if (!hasBoundedJsonShape(value))
      context.addIssue({
        code: 'custom',
        message: `JSON input must be ordinary JSON within depth ${String(NODE_TEST_JSON_MAX_DEPTH)}`,
      });
  })
  .pipe(z.json())
  .meta({
    description: `JSON input. Runtime validation rejects values deeper than ${String(NODE_TEST_JSON_MAX_DEPTH)} containers before recursive schema parsing.`,
    'x-pertexo-runtime-max-depth': NODE_TEST_JSON_MAX_DEPTH,
  });
