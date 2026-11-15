import { z } from 'zod';

const projections = new WeakMap<z.ZodType, z.ZodType>();

/** Keep the declared checks/transforms while projecting unknown response fields. */
export function responseProjection(schema: z.ZodType): z.ZodType {
  const existing = projections.get(schema);
  if (existing !== undefined) return existing;
  const projected = projectSchema(schema);
  projections.set(schema, projected);
  return projected;
}

function projectSchema(schema: z.ZodType): z.ZodType {
  const copy = (fields: Readonly<Record<string, unknown>>): z.ZodType =>
    schema.clone({ ...schema.def, ...fields });
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const projected = schema.clone({
      ...schema.def,
      shape: Object.fromEntries(
        Object.entries(shape).map(([key, child]) => [
          key,
          responseProjection(child),
        ]),
      ),
    });
    const catchall = schema.def.catchall;
    if (catchall instanceof z.ZodNever) return projected.strip();
    if (catchall === undefined) return projected;
    return projected.clone({
      ...projected.def,
      catchall: responseProjection(catchall as z.ZodType),
    });
  }
  if (schema instanceof z.ZodArray)
    return copy({ element: responseProjection(schema.element as z.ZodType) });
  if (schema instanceof z.ZodUnion)
    return copy({
      options: (schema.options as readonly z.ZodType[]).map(responseProjection),
    });
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional
  )
    return copy({
      innerType: responseProjection(schema.def.innerType as z.ZodType),
    });
  if (schema instanceof z.ZodRecord)
    return copy({
      valueType: responseProjection(schema.valueType as z.ZodType),
    });
  if (schema instanceof z.ZodIntersection)
    return copy({
      left: responseProjection(schema.def.left as z.ZodType),
      right: responseProjection(schema.def.right as z.ZodType),
    });
  if (schema instanceof z.ZodPipe)
    return copy({
      in: responseProjection(schema.def.in as z.ZodType),
      out: responseProjection(schema.def.out as z.ZodType),
    });
  if (schema instanceof z.ZodLazy)
    return copy({
      getter: () => responseProjection(schema.unwrap() as z.ZodType),
    });
  return schema;
}
