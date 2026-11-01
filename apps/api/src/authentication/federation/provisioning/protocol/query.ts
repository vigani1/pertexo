import { z } from 'zod';
import {
  DirectoryError,
  DIRECTORY_LIMITS,
  type DirectoryQuery,
} from '@pertexo/core/tenant-access';
import {
  canonicalPath,
  supportedAttributes,
  type DirectoryResourceType,
} from './core.js';
import { parseDirectoryFilter } from './filter.js';

const integer = z.coerce.number().int().min(-2147483647).max(2147483647);
const querySchema = z
  .object({
    filter: z.string().max(DIRECTORY_LIMITS.filterCharacters).optional(),
    startIndex: integer.default(1),
    count: integer.default(DIRECTORY_LIMITS.page),
    sortBy: z.string().max(256).optional(),
    sortOrder: z.enum(['ascending', 'descending']).default('ascending'),
    attributes: z.string().max(2048).optional(),
    excludedAttributes: z.string().max(2048).optional(),
  })
  .strict();
export type DirectoryProjection = Readonly<{
  included: readonly string[];
  excluded: readonly string[];
}>;
export function parseDirectoryQuery(
  input: unknown,
  kind: DirectoryResourceType,
): Readonly<{ query: DirectoryQuery; projection: DirectoryProjection }> {
  try {
    const value = querySchema.parse(input);
    const paths = (source: string | undefined) =>
      source === undefined
        ? []
        : source.split(',').map((part) => canonicalPath(part.trim(), kind));
    const included = paths(value.attributes),
      excluded = paths(value.excludedAttributes);
    if (included.length > 0 && excluded.length > 0)
      throw new DirectoryError('invalid_value');
    const descriptors = supportedAttributes(kind);
    for (const path of [...included, ...excluded]) {
      const [root, child, ...rest] = path.split('.'),
        attribute = descriptors.find((field) => field.name === root);
      const unknownAttributePath =
        attribute === undefined ||
        rest.length !== 0 ||
        (child !== undefined &&
          !attribute.subAttributes?.some((field) => field.name === child));
      if (unknownAttributePath) throw new DirectoryError('invalid_path');
    }
    return {
      query: {
        startIndex: Math.max(1, value.startIndex),
        count: Math.max(0, Math.min(DIRECTORY_LIMITS.page, value.count)),
        sortOrder: value.sortOrder,
        ...(value.sortBy === undefined
          ? {}
          : { sortBy: canonicalPath(value.sortBy, kind) }),
        ...(value.filter === undefined
          ? {}
          : { filter: parseDirectoryFilter(value.filter) }),
      },
      projection: { included, excluded },
    };
  } catch (error: unknown) {
    if (error instanceof DirectoryError) throw error;
    throw new DirectoryError('invalid_value');
  }
}
export function projectDirectoryDocument(
  document: Readonly<Record<string, unknown>>,
  projection: DirectoryProjection,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === 'id' || key === 'schemas') {
      result[key] = value;
      continue;
    }
    const paths = projection.included.filter((path) =>
      path.startsWith(`${key}.`),
    );
    const omittedAttribute =
      projection.excluded.includes(key) ||
      (projection.included.length > 0 &&
        !projection.included.includes(key) &&
        paths.length === 0);
    if (omittedAttribute) continue;
    const pick = (item: unknown) => {
      if (typeof item !== 'object' || item === null) return item;
      return Object.fromEntries(
        Object.entries(item).filter(
          ([child]) =>
            !projection.excluded.includes(`${key}.${child}`) &&
            (paths.length === 0 || paths.includes(`${key}.${child}`)),
        ),
      );
    };
    result[key] = Array.isArray(value) ? value.map(pick) : pick(value);
  }
  return result;
}
