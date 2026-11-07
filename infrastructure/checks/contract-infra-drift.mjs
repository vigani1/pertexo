import path from 'node:path';

import ts from 'typescript';

/** Keep transport vocabulary below declarations and generated documents. */
export function validateContractDependencies(file, source) {
  if (!file.startsWith('packages/contracts/src/')) return [];
  const errors = [];
  const area = file.split('/')[3];
  for (const statement of source.statements) {
    if (
      (!ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier),
    );
    const targetArea = target.split('/')[3];
    if (
      (['schemas', 'errors'].includes(area) &&
        ['routes', 'openapi'].includes(targetArea)) ||
      (area === 'routes' && targetArea === 'openapi')
    )
      errors.push(
        `${file}: contracts dependency points above its owner: ${specifier}`,
      );
    if (
      area === 'schemas' &&
      targetArea === 'schemas' &&
      ts.isExportDeclaration(statement) &&
      statement.exportClause === undefined
    )
      errors.push(
        `${file}: publish schema vocabulary from the package entry, not another schema`,
      );
  }
  return errors;
}

/** Check source ownership, so leftover build output cannot hide a stale path. */
export function validateInfrastructureBuiltPaths(file, source, sources) {
  if (!file.startsWith('infrastructure/')) return [];
  // These tests contain synthetic source strings for the architecture checker.
  if (file.startsWith('infrastructure/checks/') && file.endsWith('.test.mjs'))
    return [];
  const errors = [];
  const inspect = (node) => {
    if (ts.isStringLiteralLike(node))
      for (const match of node.text.matchAll(
        /\b((?:apps|packages)\/[a-z0-9-]+)\/dist\/([a-zA-Z0-9_./-]+)\.m?js\b/gu,
      )) {
        const target = `${match[1]}/src/${match[2]}`;
        if (
          !['.ts', '.tsx', '.mjs', '.js'].some((extension) =>
            Object.hasOwn(sources, target + extension),
          )
        )
          errors.push(`${file}: built path has no source owner: ${match[0]}`);
      }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return [...new Set(errors)];
}
