import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  entriesAddedSince,
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

const CORE_SOURCE = 'packages/core/src/';
// Repositories hold the queries; a store is the flow's facade and may run
// the ones it owns (AGENTS.md: "Database access").
const QUERY_ROLES = /\.(?:repository|store)\.ts$/u;

// PENDING_AREAS as it stood when the check began; it stays within this list.
// `artifacts` and `triggers` already kept their queries in repositories.
const ORIGINAL_PENDING_AREAS = Object.freeze([
  'attempts',
  'authoring',
  'connections',
  'data-tables',
  'governance',
  'identity',
  'inbox',
  'lifecycle',
  'notifications',
  'operator',
  'outbox',
  'previews',
  'runs',
  'shared',
  'tenant-access',
  'variables',
]);

/** Core areas whose queries haven't moved yet; this list may only shrink. */
export const PENDING_AREAS = Object.freeze([
  'attempts',
  'authoring',
  'identity',
  'inbox',
  'lifecycle',
  'previews',
  'runs',
]);

// The calls that run or start a query on a drizzle database, a pg client or
// a pool.
const QUERY_METHODS = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'query',
]);
// What holds a database handle in core: `db`, `tx`, `client`, `pool`, an
// executor, a transaction, and names ending in one of those.
const HANDLE_NAME =
  /^(?:db|tx|trx|client|pool|executor|database|transaction|connection)$|(?:Db|Tx|Client|Pool|Executor|Database|Transaction|Connection)$/u;
// Builder steps only a drizzle query chain has, so `x.delete(k).where(...)`
// is a query whatever `x` is called.
const BUILDER_STEPS = new Set([
  'from',
  'values',
  // session-setting-exempt: a drizzle builder step's name, not SQL
  'set',
  'where',
  'returning',
  'onConflictDoNothing',
  'onConflictDoUpdate',
  'for',
]);
// `sql.raw(...)`, `sql.join(...)` and friends build fragments too.
const SQL_HELPERS = new Set(['raw', 'join', 'identifier', 'placeholder']);

/** The core area a file belongs to, or undefined outside core's src. */
export function coreArea(file) {
  if (!file.startsWith(CORE_SOURCE)) return undefined;
  const [area, ...rest] = file.slice(CORE_SOURCE.length).split('/');
  return rest.length === 0 ? undefined : area;
}

/**
 * Database access outside a `.repository.ts` or `.store.ts`: a query method
 * called on a database handle or chained into a drizzle builder, and every
 * `sql` fragment (`clock_timestamp()`, increments, `now()` included).
 */
export function findCoreQueries(file, text) {
  if (!file.startsWith(CORE_SOURCE) || QUERY_ROLES.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const refuse = (node, what) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(
      `${file}:${String(line + 1)}: ${what}: move it into the area's .repository.ts (or the flow's .store.ts).`,
    );
  };
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag))
      refuse(node, 'sql fragment');
    else if (ts.isCallExpression(node)) {
      const query = queryCall(node);
      if (query !== undefined) refuse(node, query);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isSqlTag(tag) {
  if (ts.isIdentifier(tag)) return tag.text === 'sql';
  return (
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.expression.text === 'sql'
  );
}

function queryCall(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  if (
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'sql' &&
    SQL_HELPERS.has(method)
  )
    return `sql.${method}() fragment`;
  if (!QUERY_METHODS.has(method)) return undefined;
  return HANDLE_NAME.test(handleName(callee.expression)) ||
    chainsIntoBuilder(call)
    ? `.${method}() query`
    : undefined;
}

// The last name in `a.b.c` or `this.db`; '' for anything else.
function handleName(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current)
  )
    current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return '';
}

function chainsIntoBuilder(call) {
  const parent = call.parent;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === call &&
    BUILDER_STEPS.has(parent.name.text) &&
    ts.isCallExpression(parent.parent)
  );
}

/** Findings for files in an area that is still pending. */
export function isPending(file, pending = PENDING_AREAS) {
  const area = coreArea(file);
  return area !== undefined && pending.includes(area);
}

/** A pending list that gained an entry since the check began. */
export function validatePendingAreas(pending = PENDING_AREAS) {
  return entriesAddedSince('PENDING_AREAS', pending, ORIGINAL_PENDING_AREAS);
}

export async function inspectCoreQueries(root = repositoryRoot) {
  const findings = [...validatePendingAreas()];
  const pendingWithoutQueries = new Set(PENDING_AREAS);
  for (const file of await listSourceFiles('packages/core', root)) {
    const queries = findCoreQueries(file, await readSource(file, root));
    if (!isPending(file)) findings.push(...queries);
    else if (queries.length > 0) pendingWithoutQueries.delete(coreArea(file));
  }
  for (const area of pendingWithoutQueries)
    findings.push(
      `packages/core/src/${area}: has no queries outside its repositories; remove it from PENDING_AREAS.`,
    );
  return findings;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectCoreQueries(),
    "Core's queries live in repositories and stores.",
  );
