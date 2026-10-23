import SCIMMY from 'scimmy';
import type { Filter } from 'scim2-parse-filter';
import { DirectoryError } from '../contract.js';

export type DirectoryKind = 'User' | 'Group';
type Field = Readonly<{ sql: string; type: string; caseExact: boolean }>;
type Collection = 'emails' | 'members' | 'groups';
const scalarColumns = {
  id: 'resource.id::text',
  externalid: 'resource.external_id',
  'meta.created': 'resource.created_at',
  'meta.lastmodified': 'resource.updated_at',
  username: 'resource.user_name',
  active: 'resource.active',
  displayname: 'resource.display_name',
};
function attributePath(kind: DirectoryKind, path: string): string {
  const prefix = `${(kind === 'User' ? SCIMMY.Schemas.User : SCIMMY.Schemas.Group).id}:`;
  return (
    path.toLowerCase().startsWith(prefix.toLowerCase())
      ? path.slice(prefix.length)
      : path
  ).toLowerCase();
}
export function directoryField(
  kind: DirectoryKind,
  path: string,
  collection?: Collection,
): Field {
  const schema = kind === 'User' ? SCIMMY.Schemas.User : SCIMMY.Schemas.Group;
  const normalized = attributePath(kind, path);
  const fullPath =
    collection === undefined ? normalized : `${collection}.${normalized}`;
  try {
    const attribute = schema.definition.attribute(fullPath);
    let sql: string | undefined;
    if (collection === 'emails') {
      const fields: Readonly<Record<string, string>> = {
        value: "item.value->>'value'",
        type: "item.value->>'type'",
        primary: "(item.value->>'primary')::boolean",
      };
      sql = fields[normalized];
    } else if (collection !== undefined) {
      if (normalized === 'value')
        sql =
          collection === 'groups'
            ? 'item.group_id::text'
            : 'item.directory_user_id::text';
    } else if (kind === 'User' && normalized === 'displayname')
      sql = "resource.profile->>'displayName'";
    else if (kind === 'User' && normalized === 'name')
      sql = "resource.profile->'name'";
    else if (kind === 'User' && normalized.startsWith('name.')) {
      const names: Readonly<Record<string, string>> = {
        formatted: 'formatted',
        familyname: 'familyName',
        givenname: 'givenName',
        middlename: 'middleName',
        honorificprefix: 'honorificPrefix',
        honorificsuffix: 'honorificSuffix',
      };
      const key = names[normalized.slice(5)];
      if (key !== undefined) sql = `resource.profile->'name'->>'${key}'`;
    } else if (
      (normalized !== 'username' && normalized !== 'active') ||
      kind === 'User'
    )
      sql = scalarColumns[normalized as keyof typeof scalarColumns];
    if (sql === undefined) throw new DirectoryError('invalid_filter');
    return {
      sql,
      type: attribute.type,
      caseExact: attribute.config.caseExact ?? false,
    };
  } catch {
    throw new DirectoryError('invalid_filter');
  }
}
function collectionSource(
  kind: DirectoryKind,
  name: string,
): Readonly<{ collection: Collection; from: string; scope: string }> {
  const normalized = attributePath(kind, name);
  if (kind === 'User' && normalized === 'emails')
    return {
      collection: 'emails',
      from: "jsonb_array_elements(resource.profile->'emails') item(value)",
      scope: 'true',
    };
  if (kind === 'User' && normalized === 'groups')
    return {
      collection: 'groups',
      from: 'app.auth_directory_group_members item',
      scope:
        'item.organization_id=resource.organization_id and item.directory_user_id=resource.id',
    };
  if (kind === 'Group' && normalized === 'members')
    return {
      collection: 'members',
      from: 'app.auth_directory_group_members item',
      scope:
        'item.organization_id=resource.organization_id and item.group_id=resource.id',
    };
  throw new DirectoryError('invalid_filter');
}
export function compileDirectoryFilter(
  kind: DirectoryKind,
  filter: Filter | undefined,
  parameters: unknown[],
): string {
  const bind = (value: unknown) => {
    parameters.push(value);
    return `$${String(parameters.length)}`;
  };
  const compile = (node: Filter, collection?: Collection): string => {
    if (node.op === 'and' || node.op === 'or')
      return `(${node.filters.map((child) => compile(child, collection)).join(node.op === 'and' ? ' and ' : ' or ')})`;
    if (node.op === 'not') return `(not ${compile(node.filter, collection)})`;
    if (node.op === '[]') {
      if (collection !== undefined) throw new DirectoryError('invalid_filter');
      const source = collectionSource(kind, node.attrPath);
      return `exists(select 1 from ${source.from} where ${source.scope} and ${compile(node.valFilter, source.collection)})`;
    }
    const path = attributePath(kind, node.attrPath);
    if (
      collection === undefined &&
      ['emails', 'members', 'groups'].some(
        (name) => path === name || path.startsWith(`${name}.`),
      )
    ) {
      const [name = '', ...rest] = path.split('.'),
        source = collectionSource(kind, name);
      if (rest.length === 0 && node.op !== 'pr')
        throw new DirectoryError('invalid_filter');
      return `exists(select 1 from ${source.from} where ${source.scope}${rest.length === 0 ? '' : ` and ${compile({ ...node, attrPath: rest.join('.') }, source.collection)}`})`;
    }
    const field = directoryField(kind, node.attrPath, collection);
    if (node.op === 'pr') {
      if (field.type === 'string' || field.type === 'reference')
        return `(nullif(${field.sql},'') is not null)`;
      if (field.type === 'complex')
        return `(${field.sql} is not null and ${field.sql}<>'{}'::jsonb)`;
      return `(${field.sql} is not null)`;
    }
    if (field.type === 'complex') throw new DirectoryError('invalid_filter');
    if (node.compValue === null) {
      if (node.op !== 'eq' && node.op !== 'ne')
        throw new DirectoryError('invalid_filter');
      return `(${field.sql} is ${node.op === 'ne' ? 'not ' : ''}null)`;
    }
    if (
      field.type === 'boolean' &&
      (typeof node.compValue !== 'boolean' || !['eq', 'ne'].includes(node.op))
    )
      throw new DirectoryError('invalid_filter');
    if (field.type !== 'boolean' && typeof node.compValue !== 'string')
      throw new DirectoryError('invalid_filter');
    const date = field.type === 'dateTime';
    if (
      date &&
      (typeof node.compValue !== 'string' ||
        !Number.isFinite(Date.parse(node.compValue)))
    )
      throw new DirectoryError('invalid_filter');
    const text = field.type !== 'boolean' && !date;
    const left = text && !field.caseExact ? `lower(${field.sql})` : field.sql;
    const parameter = bind(node.compValue);
    const right = comparisonParameter(parameter, {
      date,
      text,
      caseExact: field.caseExact,
    });
    if (['co', 'sw', 'ew'].includes(node.op)) {
      if (!text) throw new DirectoryError('invalid_filter');
      const comparison = substringComparison(node.op, left, right);
      return `coalesce((${comparison}),false)`;
    }
    const operators = {
      eq: '=',
      ne: '<>',
      gt: '>',
      lt: '<',
      ge: '>=',
      le: '<=',
    };
    const operator = operators[node.op as keyof typeof operators];
    return `coalesce((${left}${operator}${right}),false)`;
  };
  // The public boundary parses and bounds this AST before it enters storage.
  return filter === undefined ? 'true' : compile(filter);
}

function comparisonParameter(
  parameter: string,
  {
    date,
    text,
    caseExact,
  }: Readonly<{ date: boolean; text: boolean; caseExact: boolean | undefined }>,
): string {
  if (date) {
    return `${parameter}::timestamptz`;
  }
  if (text && !caseExact) {
    return `lower(${parameter}::text)`;
  }
  return parameter;
}

function substringComparison(
  operator: Filter['op'],
  left: string,
  right: string,
): string {
  if (operator === 'co') {
    return `strpos(${left},${right})>0`;
  }
  if (operator === 'sw') {
    return `left(${left},length(${right}))=${right}`;
  }
  return `right(${left},length(${right}))=${right}`;
}
