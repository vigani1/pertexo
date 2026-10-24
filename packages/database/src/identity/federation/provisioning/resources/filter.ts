import { and, exists, sql, type SQL } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { directoryUsers, directoryGroups, directoryMembers } from './tables.js';
import SCIMMY from 'scimmy';
import type { AttrExp, Compare, Filter } from 'scim2-parse-filter';
import { DirectoryError } from '../contract.js';

export type DirectoryKind = 'User' | 'Group';
type Field = Readonly<{ sql: SQL; type: string; caseExact: boolean }>;
type Collection = 'emails' | 'members' | 'groups';
function scalarColumns(kind: DirectoryKind): Readonly<Record<string, SQL>> {
  const table = kind === 'User' ? directoryUsers : directoryGroups;
  return {
    id: sql`${table.id}::text`,
    externalid: sql`${table.externalId}`,
    'meta.created': sql`${table.createdAt}`,
    'meta.lastmodified': sql`${table.updatedAt}`,
    username: sql`${directoryUsers.userName}`,
    active: sql`${directoryUsers.active}`,
    displayname: sql`${directoryGroups.displayName}`,
  };
}
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
    const sql = directoryFieldSql(kind, normalized, collection);
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
const emailColumns: Readonly<Record<string, SQL>> = {
  value: sql`item.value->>'value'`,
  type: sql`item.value->>'type'`,
  primary: sql`(item.value->>'primary')::boolean`,
};
const nameColumns: Readonly<Record<string, string>> = {
  formatted: 'formatted',
  familyname: 'familyName',
  givenname: 'givenName',
  middlename: 'middleName',
  honorificprefix: 'honorificPrefix',
  honorificsuffix: 'honorificSuffix',
};
function directoryFieldSql(
  kind: DirectoryKind,
  normalized: string,
  collection: Collection | undefined,
): SQL | undefined {
  switch (collection) {
    case 'emails':
      return emailColumns[normalized];
    case 'groups':
      return normalized === 'value'
        ? sql`${directoryMembers.groupId}::text`
        : undefined;
    case 'members':
      return normalized === 'value'
        ? sql`${directoryMembers.directoryUserId}::text`
        : undefined;
    case undefined:
      if (kind === 'User') return userFieldSql(normalized);
      if (normalized === 'username' || normalized === 'active')
        return undefined;
      return scalarColumns(kind)[normalized];
  }
}
function userFieldSql(normalized: string): SQL | undefined {
  switch (normalized) {
    case 'displayname':
      return sql`${directoryUsers.profile}->>'displayName'`;
    case 'name':
      return sql`${directoryUsers.profile}->'name'`;
    default:
      if (normalized.startsWith('name.')) {
        const key = nameColumns[normalized.slice(5)];
        return key === undefined
          ? undefined
          : sql`${directoryUsers.profile}->'name'->>${key}`;
      }
      return scalarColumns('User')[normalized];
  }
}
function collectionSource(
  kind: DirectoryKind,
  name: string,
): Readonly<{
  collection: Collection;
  from: SQL | typeof directoryMembers;
  scope: SQL;
}> {
  const normalized = attributePath(kind, name);
  if (kind === 'User' && normalized === 'emails')
    return {
      collection: 'emails',
      from: sql`jsonb_array_elements(${directoryUsers.profile}->'emails') item(value)`,
      scope: sql`true`,
    };
  if (kind === 'User' && normalized === 'groups')
    return {
      collection: 'groups',
      from: directoryMembers,
      scope: sql`${directoryMembers.organizationId}=${directoryUsers.organizationId} and ${directoryMembers.directoryUserId}=${directoryUsers.id}`,
    };
  if (kind === 'Group' && normalized === 'members')
    return {
      collection: 'members',
      from: directoryMembers,
      scope: sql`${directoryMembers.organizationId}=${directoryGroups.organizationId} and ${directoryMembers.groupId}=${directoryGroups.id}`,
    };
  throw new DirectoryError('invalid_filter');
}
export function compileDirectoryFilter(
  kind: DirectoryKind,
  filter: Filter | undefined,
): SQL {
  const compile = (node: Filter, collection?: Collection): SQL => {
    if (node.op === 'and' || node.op === 'or')
      return sql`(${sql.join(
        node.filters.map((child) => compile(child, collection)),
        node.op === 'and' ? sql` and ` : sql` or `,
      )})`;
    if (node.op === 'not')
      return sql`(not ${compile(node.filter, collection)})`;
    if (node.op === '[]') {
      if (collection !== undefined) throw new DirectoryError('invalid_filter');
      const source = collectionSource(kind, node.attrPath);
      return exists(
        new QueryBuilder()
          .select({ one: sql`1` })
          .from(source.from)
          .where(and(source.scope, compile(node.valFilter, source.collection))),
      );
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
      const condition =
        rest.length === 0
          ? undefined
          : compile({ ...node, attrPath: rest.join('.') }, source.collection);
      return exists(
        new QueryBuilder()
          .select({ one: sql`1` })
          .from(source.from)
          .where(and(source.scope, condition)),
      );
    }
    return compileAttributeComparison(
      directoryField(kind, node.attrPath, collection),
      node,
    );
  };
  // The public boundary parses and bounds this AST before it enters storage.
  return filter === undefined ? sql`true` : compile(filter);
}

function comparisonParameter(
  parameter: SQL,
  {
    date,
    text,
    caseExact,
  }: Readonly<{ date: boolean; text: boolean; caseExact: boolean | undefined }>,
): SQL {
  if (date) {
    return sql`${parameter}::timestamptz`;
  }
  if (text && !caseExact) {
    return sql`lower(${parameter}::text)`;
  }
  return parameter;
}

function substringComparison(
  operator: Filter['op'],
  left: SQL,
  right: SQL,
): SQL {
  if (operator === 'co') {
    return sql`strpos(${left},${right})>0`;
  }
  if (operator === 'sw') {
    return sql`left(${left},length(${right}))=${right}`;
  }
  return sql`right(${left},length(${right}))=${right}`;
}

function compileAttributeComparison(field: Field, node: AttrExp): SQL {
  if (node.op === 'pr') {
    if (field.type === 'string' || field.type === 'reference')
      return sql`(nullif(${field.sql},'') is not null)`;
    if (field.type === 'complex')
      return sql`(${field.sql} is not null and ${field.sql}<>'{}'::jsonb)`;
    return sql`(${field.sql} is not null)`;
  }

  if (field.type === 'complex') throw new DirectoryError('invalid_filter');
  if (node.compValue === null) {
    if (node.op !== 'eq' && node.op !== 'ne')
      throw new DirectoryError('invalid_filter');
    return node.op === 'ne'
      ? sql`(${field.sql} is not null)`
      : sql`(${field.sql} is null)`;
  }

  return compileValueComparison(field, node);
}
function comparisonOperands(field: Field, node: Compare) {
  const invalidBooleanComparison =
    field.type === 'boolean' &&
    (typeof node.compValue !== 'boolean' || !['eq', 'ne'].includes(node.op));
  if (invalidBooleanComparison) throw new DirectoryError('invalid_filter');
  if (field.type !== 'boolean' && typeof node.compValue !== 'string')
    throw new DirectoryError('invalid_filter');
  const date = field.type === 'dateTime';
  const invalidDateComparison =
    date &&
    (typeof node.compValue !== 'string' ||
      !Number.isFinite(Date.parse(node.compValue)));
  if (invalidDateComparison) throw new DirectoryError('invalid_filter');
  const text = field.type !== 'boolean' && !date;
  const left = text && !field.caseExact ? sql`lower(${field.sql})` : field.sql;
  const parameter = sql`${node.compValue}`;
  const right = comparisonParameter(parameter, {
    date,
    text,
    caseExact: field.caseExact,
  });
  return { left, right, text };
}
function compileValueComparison(field: Field, node: Compare): SQL {
  const { left, right, text } = comparisonOperands(field, node);
  let comparison: SQL;
  switch (node.op) {
    case 'co':
    case 'sw':
    case 'ew':
      if (!text) throw new DirectoryError('invalid_filter');
      return sql`coalesce((${substringComparison(node.op, left, right)}),false)`;
    case 'eq':
      comparison = sql`${left}=${right}`;
      break;
    case 'ne':
      comparison = sql`${left}<>${right}`;
      break;
    case 'gt':
      comparison = sql`${left}>${right}`;
      break;
    case 'lt':
      comparison = sql`${left}<${right}`;
      break;
    case 'ge':
      comparison = sql`${left}>=${right}`;
      break;
    case 'le':
      comparison = sql`${left}<=${right}`;
      break;
    default:
      throw new DirectoryError('invalid_filter');
  }
  return sql`coalesce((${comparison}),false)`;
}
