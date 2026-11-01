import SCIMMY from 'scimmy';
import { DirectoryError } from '@pertexo/core/identity';
import { DIRECTORY_LIMITS } from '@pertexo/workflow-model';

export type DirectoryResourceType = 'User' | 'Group';
export const coreSchema = (kind: DirectoryResourceType) =>
  kind === 'User' ? SCIMMY.Schemas.User : SCIMMY.Schemas.Group;
const supported = {
  User: [
    'userName',
    'externalId',
    'active',
    'displayName',
    'name',
    'emails',
    'groups',
  ],
  Group: ['externalId', 'displayName', 'members'],
};
export function supportedAttributes(kind: DirectoryResourceType) {
  return coreSchema(kind).definition.attributes.filter(
    (attribute) =>
      supported[kind].includes(attribute.name) ||
      ['id', 'schemas', 'meta'].includes(attribute.name),
  );
}
const canonicalNames = new Map<string, string>([
  ['schemas', 'schemas'],
  ['operations', 'Operations'],
  ['op', 'op'],
  ['path', 'path'],
  ['value', 'value'],
]);
function remember(attributes: readonly SCIMMY.Types.Attribute[]) {
  for (const attribute of attributes) {
    canonicalNames.set(attribute.name.toLowerCase(), attribute.name);
    remember(attribute.subAttributes ?? []);
  }
}
remember([...supportedAttributes('User'), ...supportedAttributes('Group')]);

/** Reject dangerous nesting before any SDK expands the incoming resource. */
export function canonicalDocument(value: unknown): unknown {
  let members = 0;
  const visit = (current: unknown, depth: number): unknown => {
    if (
      depth > DIRECTORY_LIMITS.jsonDepth ||
      ++members > DIRECTORY_LIMITS.jsonMembers
    )
      throw new DirectoryError('limit');
    if (Array.isArray(current))
      return current.map((item: unknown) => visit(item, depth + 1));
    if (typeof current !== 'object' || current === null) return current;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(current)) {
      const name = canonicalNames.get(key.toLowerCase());
      if (name === undefined || Object.hasOwn(result, name))
        throw new DirectoryError('invalid_value');
      Object.defineProperty(result, name, {
        value: visit(item, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };
  return visit(value, 0);
}

export function canonicalPath(
  path: string,
  kind: DirectoryResourceType,
): string {
  if (path.length > DIRECTORY_LIMITS.filterCharacters)
    throw new DirectoryError('limit');
  const prefix = `${coreSchema(kind).id}:`;
  const unqualified = path.toLowerCase().startsWith(prefix.toLowerCase())
    ? path.slice(prefix.length)
    : path;
  return unqualified.replace(/"(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$-]*/g, (token) =>
    token.startsWith('"')
      ? token
      : (canonicalNames.get(token.toLowerCase()) ?? token.toLowerCase()),
  );
}

export function requireSupportedInput(
  value: unknown,
  kind: DirectoryResourceType,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DirectoryError('invalid_value');
  const names = new Set(
    supportedAttributes(kind).map((attribute) => attribute.name),
  );
  for (const name of Object.keys(value))
    if (!names.has(name)) throw new DirectoryError('invalid_value');
  const schemas: unknown = Reflect.get(value, 'schemas');
  if (
    !Array.isArray(schemas) ||
    schemas.length !== 1 ||
    schemas[0] !== coreSchema(kind).id
  )
    throw new DirectoryError('invalid_value');
}
