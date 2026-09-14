import console from 'node:console';
import { readFile, readdir, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function isRuntimeDeclaration(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.isTypeOnly) return false;
    const bindings = clause?.namedBindings;
    return !(
      clause &&
      !clause.name &&
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  }
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  return !(
    clause &&
    ts.isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

async function existingFile(candidates) {
  for (const candidate of candidates)
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  return undefined;
}

async function resolveSourceFile(from, specifier) {
  const target = path.resolve(path.dirname(from), specifier);
  const withoutJs = target.replace(/\.(?:m?js|cjs)$/u, '');
  return existingFile([
    target,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    path.join(withoutJs, 'index.ts'),
  ]);
}

async function workspacePackages(root) {
  const result = [];
  for (const parent of ['packages', 'apps']) {
    let entries;
    try {
      entries = await readdir(path.join(root, parent), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(root, parent, entry.name);
      const manifest = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      );
      if (typeof manifest.name === 'string')
        result.push({
          name: manifest.name,
          directory,
          exports: manifest.exports,
          browser: manifest.browser,
        });
    }
  }
  return result.sort((left, right) => right.name.length - left.name.length);
}

function exportTarget(definition) {
  if (typeof definition === 'string') return definition;
  if (definition === null || typeof definition !== 'object') return undefined;
  if (definition.browser === false) return false;
  return definition.browser ?? definition.default ?? definition.import;
}

async function resolveWorkspaceImport(packages, specifier) {
  const owner = packages.find(
    ({ name }) => specifier === name || specifier.startsWith(`${name}/`),
  );
  if (!owner) return undefined;
  const subpath =
    specifier === owner.name ? '.' : `.${specifier.slice(owner.name.length)}`;
  const definition = owner.exports?.[subpath];
  const target = exportTarget(definition);
  if (target === false) return false;
  if (typeof target !== 'string') return undefined;
  if (owner.browser?.[target] === false) return false;
  const sourceTarget = target
    .replace(/^\.\/dist\//u, './src/')
    .replace(/\.(?:m?js|cjs)$/u, '.ts');
  return existingFile([path.resolve(owner.directory, sourceTarget)]);
}

function runtimeSpecifiers(source, file, errors) {
  const specifiers = [];
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isRuntimeDeclaration(statement)
    )
      specifiers.push(statement.moduleSpecifier.text);
  }
  const inspect = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument))
        errors.push(
          `${file}: browser-reachable dynamic import must use a string literal`,
        );
      else specifiers.push(argument.text);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return specifiers;
}

export async function inspectBrowserEntryDependencies({ root, entries }) {
  const workspaceRoot = path.resolve(root);
  const packages = await workspacePackages(workspaceRoot);
  const errors = [];
  const visited = new Set();
  const visit = async (file, trail) => {
    const absolute = path.resolve(workspaceRoot, file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = ts.createSourceFile(
      absolute,
      await readFile(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const specifier of runtimeSpecifiers(source, absolute, errors)) {
      if (builtins.has(specifier) || specifier.startsWith('node:')) {
        errors.push(
          `${[...trail, absolute].join(' -> ')}: reaches Node builtin ${specifier}`,
        );
        continue;
      }
      if (/(?:^|\/)server(?:-only)?(?:\.js)?$/u.test(specifier)) {
        errors.push(
          `${[...trail, absolute].join(' -> ')}: reaches server-only import ${specifier}`,
        );
        continue;
      }
      const target = specifier.startsWith('.')
        ? await resolveSourceFile(absolute, specifier)
        : await resolveWorkspaceImport(packages, specifier);
      if (target === false) {
        errors.push(
          `${[...trail, absolute].join(' -> ')}: ${specifier} has no browser export`,
        );
        continue;
      }
      if (target) await visit(target, [...trail, absolute]);
    }
  };
  for (const entry of entries) await visit(entry, []);
  return errors;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];
  const entries = process.argv.filter(
    (argument, index) =>
      index > 1 && index !== rootIndex && index !== rootIndex + 1,
  );
  const errors = await inspectBrowserEntryDependencies({ root, entries });
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Browser entries have no reachable Node or server-only dependencies.',
    );
}
