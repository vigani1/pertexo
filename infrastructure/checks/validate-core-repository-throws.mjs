import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { followThrowingExports } from './core-repository-exports.mjs';

import {
  STORAGE_INTEGRITY_DECODERS,
  STORAGE_INTEGRITY_ERRORS,
} from './core-repository-throws.mjs';
import {
  listSourceFiles,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

const CORE_SOURCE = /^packages\/core\/src\/.+\.ts$/u;
const REPOSITORY = /^packages\/core\/src\/.+\.repository\.ts$/u;
const QUERY_ROLE = /\.(?:repository|store)\.ts$/u;

/**
 * The domain errors a core source raises: `throw new X(…)`, `throw x()`,
 * `throw x` and `Promise.reject(…)` of any of those, looking through
 * parentheses and type assertions. `Error` and a listed integrity error are
 * allowed, unless `Error` is another class imported under that name.
 * Rethrowing a caught value (`throw error` from a `catch` binding or a
 * rejection handler's parameter) is not counted; a thrown variable is named by
 * the class it was built from.
 */
export function findThrownErrors(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imported = importedNames(source);
  const found = [];
  const record = (node, expression) => {
    for (const name of thrownNames(unwrap(expression), source, imported)) {
      if (name !== undefined && !integrityError(name, imported)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push({ file, line: line + 1, name, node });
      }
    }
  };
  const visit = (node) => {
    if (ts.isThrowStatement(node) && node.expression !== undefined)
      record(node, node.expression);
    else if (isPromiseReject(node) && node.arguments[0] !== undefined)
      record(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const constructions = [];
  const inspect = (node) => {
    if (ts.isNewExpression(node)) {
      const name = resolved(node.expression.getText(source), imported);
      if (
        /(?:Error|Mismatch)$/u.test(name) &&
        !integrityError(name, imported)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        constructions.push({ file, line: line + 1, name, node });
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return [
    ...found.filter(
      (item) => !constructions.some((built) => built.name === item.name),
    ),
    ...constructions,
  ].sort((a, b) => a.node.getStart() - b.node.getStart());
}

/** The domain throws written in a core repository. */
export function findDomainThrows(file, text) {
  if (!REPOSITORY.test(file)) return [];
  return findThrownErrors(file, text).map(({ file, line, name }) => ({
    file,
    line,
    name,
  }));
}

/**
 * A repository returns a row, a boolean or nothing, and the operation decides
 * and throws (core's AGENTS.md): every domain throw in a core repository is a
 * finding.
 */
export function repositoryThrowFindings(throwsByFile) {
  return [...throwsByFile.values()]
    .flat()
    .map(
      (t) =>
        `${t.file}:${String(t.line)}: ${t.name} thrown in a repository. Return the row, boolean or nothing and throw in the operation, or list a storage integrity error in STORAGE_INTEGRITY_ERRORS with its reason.`,
    );
}

/**
 * Functions of a non-repository core module that raise a domain error, so a
 * repository calling one would decide one hop away. A listed integrity decoder
 * is allowed.
 */
export function throwingFunctions(file, text) {
  const throwing = new Set();
  for (const thrown of findThrownErrors(file, text)) {
    let node = thrown.node;
    while (!ts.isSourceFile(node.parent)) node = node.parent;
    if (
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )
    )
      throwing.add('default');
    if (ts.isExportAssignment(node)) throwing.add('default');
    const name = declaredName(node);
    if (name !== undefined && !Object.hasOwn(STORAGE_INTEGRITY_DECODERS, name))
      throwing.add(name);
  }
  return throwing;
}

/** Value imports in a repository of throwing functions from core operations. */
export function repositoryHops(
  file,
  text,
  throwingByModule,
  callsOnly = false,
) {
  if (!REPOSITORY.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hops = [];
  const used = new Set();
  const calls = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      let target = unwrap(node.expression);
      while (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      )
        target = unwrap(target.expression);
      if (ts.isIdentifier(target)) used.add(target.text);
    }
    ts.forEachChild(node, calls);
  };
  calls(source);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    const specifier = statement.moduleSpecifier.text;
    if (clause === undefined || clause.isTypeOnly || !specifier.startsWith('.'))
      continue;
    const target = path.posix
      .join(path.posix.dirname(file), specifier)
      .replace(/\.js$/u, '.ts');
    const throwing = throwingByModule.get(target);
    const bindings = clause.namedBindings;
    if (throwing === undefined) continue;
    if (throwing.has('*'))
      hops.push({ file, target, name: '*', unsupported: true });
    if (
      clause.name !== undefined &&
      (!callsOnly || used.has(clause.name.text)) &&
      throwing.has('default')
    )
      hops.push({ file, target, name: 'default' });
    if (bindings === undefined) continue;
    if (
      ts.isNamespaceImport(bindings) &&
      (!callsOnly || used.has(bindings.name.text))
    ) {
      for (const name of throwing) hops.push({ file, target, name });
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (
        !element.isTypeOnly &&
        (!callsOnly || used.has(element.name.text)) &&
        throwing.has(name)
      )
        hops.push({ file, target, name });
    }
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    )
      hops.push({
        file,
        target: 'dynamic import',
        name: 'unresolved runtime module',
        unsupported: true,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hops.map((hop) => ({
    ...hop,
    chain: throwingByModule.get(hop.target)?.chains?.get(hop.name) ?? [
      hop.name,
    ],
  }));
}

export function repositoryHopFindings(hops) {
  return hops.map(({ file, target, name, unsupported, chain }) =>
    unsupported
      ? `${file}: ${target} cannot be resolved soundly in a repository; load it in the operation instead.`
      : `${file}: imports ${name} from ${target}, which throws a domain error (${[file, ...(chain ?? [name])].join(' → ')}). Call it from the operation instead, or list it in STORAGE_INTEGRITY_DECODERS if it only refuses a corrupt stored value.`,
  );
}

/** An exemption nobody uses only widens what the check lets through. */
export function staleExemptionFindings(texts) {
  const all = texts.join('\n');
  const findings = [];
  for (const name of Object.keys(STORAGE_INTEGRITY_ERRORS))
    if (!new RegExp(String.raw`new ${name}\(`, 'u').test(all))
      findings.push(
        `STORAGE_INTEGRITY_ERRORS lists ${name}, which core never throws; remove it.`,
      );
  for (const name of Object.keys(STORAGE_INTEGRITY_DECODERS))
    if (!new RegExp(String.raw`(?:function|const) ${name}\b`, 'u').test(all))
      findings.push(
        `STORAGE_INTEGRITY_DECODERS lists ${name}, which core doesn't define; remove it.`,
      );
  return findings;
}

export async function collectRepositoryThrows(root = repositoryRoot) {
  const throwsByFile = new Map();
  for (const file of await listSourceFiles('packages/core', root))
    if (REPOSITORY.test(file))
      throwsByFile.set(
        file,
        findDomainThrows(file, await readSource(file, root)),
      );
  return throwsByFile;
}

export async function collectCoreFindings(root = repositoryRoot) {
  const texts = new Map();
  for (const file of await listSourceFiles('packages/core', root))
    if (CORE_SOURCE.test(file)) texts.set(file, await readSource(file, root));
  const throwingByModule = new Map();
  for (const [file, text] of texts)
    if (!QUERY_ROLE.test(file))
      throwingByModule.set(file, throwingFunctions(file, text));
  followCallChains(texts, throwingByModule);
  const throwsByFile = new Map();
  const hops = [];
  for (const [file, text] of texts)
    if (REPOSITORY.test(file)) {
      throwsByFile.set(file, findDomainThrows(file, text));
      hops.push(...repositoryHops(file, text, throwingByModule));
    }
  return [
    ...repositoryThrowFindings(throwsByFile),
    ...repositoryHopFindings(hops),
    ...staleExemptionFindings([...texts.values()]),
  ];
}

/** Propagate monotonically: cycles terminate because each declaration is added once. */
function followCallChains(texts, throwingByModule) {
  const modules = [];
  for (const [file, text] of texts) {
    const names = throwingByModule.get(file);
    if (!names) continue;
    names.chains = new Map([...names].map((name) => [name, [name]]));
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((node) => node.getText(source))
      .join('\n');
    modules.push({ file, source, imports, names });
  }
  let changed = true;
  while (changed) {
    const before = [...throwingByModule.values()].reduce(
      (sum, names) => sum + names.size,
      0,
    );
    followThrowingExports(texts, throwingByModule);
    for (const { file, source, imports, names } of modules) {
      for (const statement of source.statements) {
        const name =
          ts.isExportAssignment(statement) ||
          statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
          )
            ? 'default'
            : declaredName(statement);
        if (
          !name ||
          names.has(name) ||
          Object.hasOwn(STORAGE_INTEGRITY_DECODERS, name)
        )
          continue;
        const body = statement.getText(source);
        const hop = repositoryHops(
          path.posix.join(path.posix.dirname(file), 'chain.repository.ts'),
          imports + '\n' + body,
          throwingByModule,
          true,
        )[0];
        let local;
        const visit = (node) => {
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            let target = unwrap(node.expression);
            while (
              ts.isPropertyAccessExpression(target) ||
              ts.isElementAccessExpression(target)
            )
              target = unwrap(target.expression);
            if (ts.isIdentifier(target) && names.has(target.text))
              local ??= target.text;
          }
          ts.forEachChild(node, visit);
        };
        visit(statement);
        if (hop || local) {
          names.add(name);
          names.chains.set(name, [
            name,
            ...(hop?.chain ?? names.chains.get(local) ?? [local]),
          ]);
        }
      }
    }
    changed =
      [...throwingByModule.values()].reduce(
        (sum, names) => sum + names.size,
        0,
      ) > before;
  }
}

function unwrap(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  )
    current = current.expression;
  return current;
}

function thrownNames(expression, source, imported) {
  const value = unwrap(expression);
  if (ts.isConditionalExpression(value))
    return [
      ...thrownNames(value.whenTrue, source, imported),
      ...thrownNames(value.whenFalse, source, imported),
    ];
  if (
    ts.isBinaryExpression(value) &&
    [
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(value.operatorToken.kind)
  )
    return [
      ...thrownNames(value.left, source, imported),
      ...thrownNames(value.right, source, imported),
    ];
  return [thrownName(value, source, imported)];
}

function thrownName(expression, source, imported) {
  if (ts.isNewExpression(expression))
    return resolved(expression.expression.getText(source), imported);
  if (ts.isCallExpression(expression))
    return `${expression.expression.getText(source)}()`;
  if (ts.isIdentifier(expression)) {
    if (caughtBinding(expression)) return undefined;
    const built = builtFrom(expression, source);
    return built === undefined ? expression.text : resolved(built, imported);
  }
  return undefined;
}

/**
 * `catch (error) { throw error; }` and `.catch((error) => { throw error; })`
 * rethrow what something else raised: the thrown name is a catch binding or a
 * rejection-handler parameter. Ordinary function parameters are not rethrows.
 */
function caughtBinding(identifier) {
  const binds = (declaration) =>
    declaration !== undefined &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === identifier.text;
  for (let node = identifier.parent; node !== undefined; node = node.parent) {
    if (ts.isCatchClause(node) && binds(node.variableDeclaration)) return true;
    if (ts.isFunctionLike(node)) {
      const parameter = node.parameters.find(binds);
      if (parameter !== undefined) {
        let handler = node;
        while (handler.parent && unwrap(handler.parent) === node)
          handler = handler.parent;
        const call = handler.parent;
        const callee = ts.isCallExpression(call)
          ? unwrap(call.expression)
          : undefined;
        return (
          parameter.initializer === undefined &&
          ts.isCallExpression(call) &&
          callee !== undefined &&
          ts.isPropertyAccessExpression(callee) &&
          ((callee.name.text === 'catch' &&
            unwrap(call.arguments[0]) === node) ||
            (callee.name.text === 'then' &&
              call.arguments[1] !== undefined &&
              unwrap(call.arguments[1]) === node))
        );
      }
    }
  }
  return false;
}

/** The class a thrown variable was built from (`const e = new X(); throw e;`). */
function builtFrom(identifier, source) {
  let match;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text &&
      node.initializer !== undefined
    ) {
      const value = unwrap(node.initializer);
      if (ts.isNewExpression(value)) match = value.expression.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return match;
}

function isPromiseReject(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() === 'Promise' &&
    node.expression.name.text === 'reject'
  );
}

/** Local names that a renamed import binds, mapped to the exported name. */
function importedNames(source) {
  const names = new Map();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        names.set(
          element.name.text,
          (element.propertyName ?? element.name).text,
        );
    if (ts.isImportDeclaration(statement) && statement.importClause?.name)
      names.set(
        statement.importClause.name.text,
        statement.importClause.name.text,
      );
  }
  for (const statement of source.statements)
    if (ts.isClassDeclaration(statement) && statement.name !== undefined)
      names.set(statement.name.text, statement.name.text);
  return names;
}

function resolved(name, imported) {
  return imported.get(name) ?? name;
}

function integrityError(name, imported) {
  if (
    [
      'Error',
      'DOMException',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'ReferenceError',
      'URIError',
      'EvalError',
      'AggregateError',
    ].includes(name)
  )
    return !imported.has(name);
  return Object.hasOwn(STORAGE_INTEGRITY_ERRORS, name);
}

function declaredName(statement) {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    return statement.name?.text;
  if (ts.isVariableStatement(statement)) {
    const [declaration] = statement.declarationList.declarations;
    return declaration !== undefined && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : undefined;
  }
  return undefined;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  report(
    await collectCoreFindings(),
    'Core repositories throw only storage integrity errors, and call nothing that throws for them.',
  );
}
