import process from 'node:process';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import {
  listSourceFiles,
  listWorkspaces,
  readSource,
  report,
  repositoryRoot,
} from './workspace-sources.mjs';

/** A config module: `config.ts`, `<subject>-config.ts`, or a file under an app's `config/`. */
export function isConfigModule(file) {
  const name = file.split('/').at(-1) ?? '';
  return (
    /^(?:[a-z0-9-]+-)?config\.tsx?$/u.test(name) ||
    /^apps\/[^/]+\/src\/(?:[^/]+\/)*config\//u.test(file)
  );
}

/**
 * Whether a source text reads the environment: `process.env`,
 * `process['env']`, `globalThis.process.env`, `const { env } = process`, or
 * `env` imported from `node:process`.
 */
export function readsEnvironment(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let found = false;
  const visit = (node) => {
    if (readsEnv(node)) found = true;
    else if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function readsEnv(node) {
  if (ts.isPropertyAccessExpression(node))
    return node.name.text === 'env' && namesProcess(node.expression);
  if (ts.isElementAccessExpression(node))
    return (
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'env' &&
      namesProcess(node.expression)
    );
  if (ts.isVariableDeclaration(node))
    return (
      node.initializer !== undefined &&
      namesProcess(node.initializer) &&
      ts.isObjectBindingPattern(node.name) &&
      node.name.elements.some((element) => {
        const key = element.propertyName ?? element.name;
        return ts.isIdentifier(key) && key.text === 'env';
      })
    );
  if (ts.isImportDeclaration(node))
    return (
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['node:process', 'process'].includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (element) => (element.propertyName ?? element.name).text === 'env',
      )
    );
  return false;
}

/** `process` or `globalThis.process`. */
function namesProcess(expression) {
  return (
    (ts.isIdentifier(expression) && expression.text === 'process') ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'process' &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'globalThis')
  );
}

export function validateEnvironmentReads(readers) {
  return readers
    .filter((file) => !isConfigModule(file))
    .map(
      (file) =>
        `${file}: read process.env only in a config module and pass the typed value inward.`,
    );
}

export async function inspectEnvironmentReads(root = repositoryRoot) {
  const readers = [];
  for (const workspace of await listWorkspaces(root))
    for (const file of await listSourceFiles(workspace, root))
      if (readsEnvironment(file, await readSource(file, root)))
        readers.push(file);
  return validateEnvironmentReads(readers);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  report(
    await inspectEnvironmentReads(),
    'Only config modules read process.env.',
  );
