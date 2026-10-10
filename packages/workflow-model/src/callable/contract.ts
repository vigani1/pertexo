import { z } from 'zod';

/** A JSON type declaration, rather than an executable JSON Schema document. */
export type CallableType =
  | Readonly<{ type: 'null' | 'boolean' | 'number' | 'string' }>
  | Readonly<{ type: 'array'; items: CallableType; maxItems: number }>
  | Readonly<{
      type: 'object';
      properties: readonly Readonly<{
        name: string;
        valueType: CallableType;
        required: boolean;
      }>[];
    }>;

/** Used inside the graph's bounded own-data admission, before semantic checks. */
export const callableTypeStructuralSchema: z.ZodType<CallableType> = z.lazy(
  () =>
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('null') }).strict(),
      z.object({ type: z.literal('boolean') }).strict(),
      z.object({ type: z.literal('number') }).strict(),
      z.object({ type: z.literal('string') }).strict(),
      z
        .object({
          type: z.literal('array'),
          items: callableTypeStructuralSchema,
          maxItems: z.number().int().nonnegative().max(10_000),
        })
        .strict(),
      z
        .object({
          type: z.literal('object'),
          properties: z
            .array(
              z
                .object({
                  name: z.string().min(1).max(64),
                  valueType: callableTypeStructuralSchema,
                  required: z.boolean(),
                })
                .strict(),
            )
            .max(10_000),
        })
        .strict(),
    ]),
);

export type CallableTypeIssue = Readonly<{
  path: string;
  code: 'duplicate_property' | 'type_depth';
}>;

/** Structural parsing has already established the descriptor's own-data shape. */
export function callableTypeIssues(
  type: CallableType,
): readonly CallableTypeIssue[] {
  const issues: CallableTypeIssue[] = [];
  const pending = [{ type, path: '$', depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (current.depth > 64) {
      issues.push({ path: current.path, code: 'type_depth' });
      continue;
    }
    if (current.type.type === 'array')
      pending.push({
        type: current.type.items,
        path: `${current.path}.items`,
        depth: current.depth + 1,
      });
    if (current.type.type !== 'object') continue;
    const names = new Set<string>();
    for (const [index, property] of current.type.properties.entries()) {
      const path = `${current.path}.properties[${String(index)}]`;
      if (names.has(property.name))
        issues.push({ path: `${path}.name`, code: 'duplicate_property' });
      names.add(property.name);
      pending.push({
        type: property.valueType,
        path: `${path}.valueType`,
        depth: current.depth + 1,
      });
    }
  }
  return issues;
}
