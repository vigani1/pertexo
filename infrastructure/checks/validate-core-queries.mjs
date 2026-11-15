import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

const CORE_SOURCE = 'packages/core/src/';
// Repositories hold the queries; a store is the flow's facade and may run
// the ones it owns (AGENTS.md: "Database access").
const QUERY_ROLES = /\.(?:repository|store)\.ts$/u;

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

/**
 * Database access outside a `.repository.ts` or `.store.ts`: a query method
 * called on a database handle or chained into a drizzle builder, and every
 * `sql` fragment (`clock_timestamp()`, increments, `now()` included).
 */
export function findCoreQueries(file, text) {
  if (!file.startsWith(CORE_SOURCE) || QUERY_ROLES.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sqlNames = sqlTagNames(source);
  const drizzleNames = drizzleOpeners(source);
  const handles = handleNames(source, drizzleNames);
  const found = [];
  const refuse = (node, what) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    found.push(
      `${file}:${String(line + 1)}: ${what}: move it into the area's .repository.ts (or the flow's .store.ts).`,
    );
  };
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag, sqlNames))
      refuse(node, 'sql fragment');
    else if (ts.isCallExpression(node)) {
      const query = queryCall(node, sqlNames, handles, drizzleNames);
      if (query !== undefined) refuse(node, query);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// The local names `sql` has in this file: itself, any alias it is imported
// under from drizzle-orm (`import { sql as q }`), and `ns.sql` for a
// namespace import (`import * as ns`), kept as `ns.sql`.
function sqlTagNames(source) {
  const names = new Set(['sql']);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('drizzle-orm')
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings))
      names.add(`${bindings.name.text}.sql`);
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if ((element.propertyName ?? element.name).text === 'sql')
        names.add(element.name.text);
  }
  return names;
}

// What holds a handle under another name: a parameter typed as one; an
// untyped parameter of a callback handed to a transaction or client helper,
// or to any call that also receives a pool or client (`(c) => c.query(…)`);
// a variable set from `drizzle(…)` or `.connect()`; and a destructured
// `db`, `client`, `tx` or `pool` under a new name (`({ db: d })`).
// Handle types, with the aliases core and database export for them; an
// alias a file writes for itself is resolved from its body (`handleTypes`).
const HANDLE_TYPE =
  /\b(?:Pool|PoolClient|ClientBase|NodePgDatabase|WorkspaceDrizzle|WorkspaceTransaction|PlatformTransaction|ResourceTransaction|DatabaseClockSource)\b/u;
const HANDLE_HELPER = /^(?:with|in)[A-Z]\w*(?:Transaction|Client|Access)$/u;

function handleNames(source, drizzleNames) {
  const names = new Set();
  const isHandleType = handleTypes(source);
  const visit = (node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      if (node.type !== undefined && isHandleType(node.type.getText()))
        names.add(node.name.text);
      else if (node.type === undefined && isHelperCallback(node.parent))
        names.add(node.name.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      opensHandle(node.initializer, drizzleNames)
    )
      names.add(node.name.text);
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.propertyName !== undefined &&
      ts.isIdentifier(node.propertyName) &&
      HANDLE_NAME.test(node.propertyName.text)
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isHelperCallback(fn) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const call = fn.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(fn) &&
    (HANDLE_HELPER.test(handleName(call.expression)) ||
      call.arguments.some(
        (argument) => argument !== fn && HANDLE_NAME.test(handleName(argument)),
      ))
  );
}

// The file's own type aliases and interfaces whose body names a handle type,
// so `type Executor = Pick<NodePgDatabase, 'execute'>` types a handle too.
function handleTypes(source) {
  const bodies = new Map();
  for (const statement of source.statements)
    if (ts.isTypeAliasDeclaration(statement))
      bodies.set(statement.name.text, statement.type.getText());
    else if (ts.isInterfaceDeclaration(statement))
      bodies.set(statement.name.text, statement.getText());
  const aliases = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of bodies)
      if (
        !aliases.has(name) &&
        (HANDLE_TYPE.test(body) ||
          [...aliases].some((alias) =>
            new RegExp(`\\b${alias}\\b`, 'u').test(body),
          ))
      ) {
        aliases.add(name);
        grew = true;
      }
  }
  return (text) =>
    HANDLE_TYPE.test(text) ||
    [...aliases].some((alias) => new RegExp(`\\b${alias}\\b`, 'u').test(text));
}

// The local names drizzle's node-postgres opener has: `drizzle`, or the
// name it is imported under (`import { drizzle as open }`).
function drizzleOpeners(source) {
  const names = new Set(['drizzle']);
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith('drizzle-orm')
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if ((element.propertyName ?? element.name).text === 'drizzle')
        names.add(element.name.text);
  }
  return names;
}

// `drizzle(c)` or `pool.connect()`, awaited or not.
function opensHandle(expression, drizzleNames) {
  const call = ts.isAwaitExpression(expression)
    ? expression.expression
    : expression;
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression;
  return (
    (ts.isIdentifier(callee) && drizzleNames.has(callee.text)) ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'connect')
  );
}

// `sql`, an alias of it, or `ns.sql` from a namespace import.
function isSqlReference(expression, sqlNames) {
  if (ts.isIdentifier(expression)) return sqlNames.has(expression.text);
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    sqlNames.has(`${expression.expression.text}.${expression.name.text}`)
  );
}

function isSqlTag(tag, sqlNames) {
  return (
    isSqlReference(tag, sqlNames) ||
    (ts.isPropertyAccessExpression(tag) &&
      isSqlReference(tag.expression, sqlNames))
  );
}

function queryCall(call, sqlNames, handles, drizzleNames) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  if (isSqlReference(callee.expression, sqlNames) && SQL_HELPERS.has(method))
    return `sql.${method}() fragment`;
  if (!QUERY_METHODS.has(method)) return undefined;
  const receiver = handleName(callee.expression, drizzleNames);
  return HANDLE_NAME.test(receiver) ||
    handles.has(receiver) ||
    chainsIntoBuilder(call, method) ||
    sendsSqlText(call, method)
    ? `.${method}() query`
    : undefined;
}

// pg's `.query('select …')` and `.execute(\`update …\`)`: SQL written as a
// plain string is a query whatever its receiver is called.
const SQL_TEXT =
  /^\s*(?:select|insert|update|delete|with|lock|set|begin|commit|rollback|savepoint|release|call|do|values)\b/iu;
function sendsSqlText(call, method) {
  if (method !== 'query' && method !== 'execute') return false;
  const [text] = call.arguments;
  if (text === undefined) return false;
  if (ts.isStringLiteralLike(text)) return SQL_TEXT.test(text.text);
  return ts.isTemplateExpression(text) && SQL_TEXT.test(text.head.text);
}

// The last name in `a.b.c` or `this.db`, `db` for a `drizzle(…)` call;
// '' for anything else.
function handleName(expression, drizzleNames = new Set(['drizzle'])) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current)
  )
    current = current.expression;
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    drizzleNames.has(current.expression.text)
  )
    return 'db';
  return '';
}

// `insert(t).select(origin)` is insert-from-select: `select` is a builder
// step only after an insert.
function chainsIntoBuilder(call, method) {
  const parent = call.parent;
  if (
    !ts.isPropertyAccessExpression(parent) ||
    parent.expression !== call ||
    !ts.isCallExpression(parent.parent)
  )
    return false;
  const step = parent.name.text;
  return BUILDER_STEPS.has(step) || (method === 'insert' && step === 'select');
}

const STORE = /\.store\.ts$/u;
const CORE_ENTRY =
  /^packages\/core\/src\/(?:testing\.ts|[^/]+\/(?:index|testing)\.ts)$/u;
const STORE_FACTORY =
  /^export\s+(?:async\s+)?(?:function\s+|const\s+)(create[A-Z]\w*)/gmu;
const ALL_NAMES = '*';

/**
 * A `.store.ts` may hold queries only as a flow's facade: it exports a
 * `create…` factory, and an area entry, a testing entry or another store
 * imports or re-exports that factory as a value. A type-only line does not
 * compose it. Anything else is a repository under another name.
 */
export function findStoreProblems(sources) {
  const composed = composedNames(sources);
  const problems = [];
  for (const [file, text] of sources) {
    if (!file.startsWith(CORE_SOURCE) || !STORE.test(file)) continue;
    const factories = [...text.matchAll(STORE_FACTORY)].map(([, name]) => name);
    const used = composed.get(file);
    if (factories.length === 0)
      problems.push(
        `${file}: a store exports the create… factory of a flow's facade; name a query file .repository.ts.`,
      );
    else if (
      used === undefined ||
      !(used.has(ALL_NAMES) || factories.some((name) => used.has(name)))
    )
      problems.push(
        `${file}: no area entry, testing entry or other store imports its create… factory as a value; name a query file .repository.ts.`,
      );
  }
  return problems;
}

// For each file an entry or store imports from, the value names it takes
// (`*` for `export * from`), leaving type-only imports and exports out.
function composedNames(sources) {
  const composed = new Map();
  for (const [file, text] of sources) {
    if (!CORE_ENTRY.test(file) && !STORE.test(file)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
    for (const statement of source.statements) {
      const target = relativeTarget(file, statement);
      if (target === undefined) continue;
      const names = composed.get(target) ?? new Set();
      for (const name of valueNames(statement)) names.add(name);
      composed.set(target, names);
    }
  }
  return composed;
}

function relativeTarget(file, statement) {
  if (
    !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
    statement.moduleSpecifier === undefined ||
    !ts.isStringLiteral(statement.moduleSpecifier)
  )
    return undefined;
  const specifier = statement.moduleSpecifier.text;
  if (!specifier.startsWith('.') || !specifier.endsWith('.js'))
    return undefined;
  return path.posix.join(
    path.posix.dirname(file),
    `${specifier.slice(0, -'.js'.length)}.ts`,
  );
}

function valueNames(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) return [];
    const bindings = clause.namedBindings;
    if (bindings === undefined) return [];
    if (ts.isNamespaceImport(bindings)) return [ALL_NAMES];
    return bindings.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text);
  }
  if (statement.isTypeOnly) return [];
  const clause = statement.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return [ALL_NAMES];
  return clause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
}

export async function inspectCoreQueries(root = repositoryRoot) {
  const findings = [];
  const sources = [];
  for (const file of await listSourceFiles('packages/core', root)) {
    const text = await readSource(file, root);
    sources.push([file, text]);
    findings.push(...findCoreQueries(file, text));
  }
  findings.push(...findStoreProblems(sources));
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
