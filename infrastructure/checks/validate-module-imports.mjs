import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const webAllowedWorkspaceImports = new Set([
  '@pertexo/contracts/schemas/artifacts',
  '@pertexo/contracts/schemas/errors',
  '@pertexo/contracts/schemas/identity-workspace',
  '@pertexo/contracts/schemas/node-testing',
  '@pertexo/contracts/schemas/failure-notifications',
  '@pertexo/contracts/schemas/schedules',
  '@pertexo/contracts/schemas/catalog',
  '@pertexo/contracts/schemas/connections',
  '@pertexo/contracts/schemas/workflow-authoring',
  '@pertexo/contracts/schemas/workflow-runs',
  '@pertexo/contracts/schemas/webhooks',
  '@pertexo/contracts/schemas/transport',
  '@pertexo/workflow-model/json-path',
]);
const webRawFetchOwners = new Set(['apps/web/src/lib/api/client.ts']);

function isRuntimeImport(statement) {
  if (ts.isImportDeclaration(statement)) {
    if (statement.importClause?.isTypeOnly) return false;
    const clause = statement.importClause;
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

/** Static local runtime imports only; deferred imports do not create startup cycles. */
export function validateModuleImports(sources) {
  const errors = [];
  const graph = new Map();
  for (const [file, text] of Object.entries(sources)) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const dependencies = [];
    const workspace = file.split('/').slice(0, 2).join('/');
    const resolveTarget = (specifier) => {
      const unresolved = specifier.startsWith('@/')
        ? path.posix.join('apps/web/src', specifier.slice(2))
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(file), specifier),
          );
      if (!unresolved.startsWith(`${workspace}/`))
        errors.push(
          `${file}: use a public workspace package export instead of ${specifier}`,
        );
      const withoutExtension = unresolved.replace(/\.(?:js|ts|tsx)$/u, '');
      return [
        unresolved,
        `${withoutExtension}.ts`,
        `${withoutExtension}.tsx`,
        `${withoutExtension}/index.ts`,
        `${withoutExtension}/index.tsx`,
      ].find((candidate) => Object.hasOwn(sources, candidate));
    };
    const inspectSpecifier = (specifier, runtime) => {
      if (file.startsWith('apps/web/src/')) {
        const featureImport = specifier.match(/^@\/features\/([^/]+)\/(.+)$/u);
        const owner = file.match(/^apps\/web\/src\/features\/([^/]+)\//u)?.[1];
        if (
          featureImport !== null &&
          featureImport[1] !== owner &&
          featureImport[2] !== 'public' &&
          !featureImport[2].endsWith('.public')
        )
          errors.push(
            `${file}: cross-feature imports must use ${`@/features/${featureImport[1]}/public`}`,
          );
        if (
          specifier.startsWith('@pertexo/') &&
          !webAllowedWorkspaceImports.has(specifier)
        )
          errors.push(
            `${file}: web source cannot import unreviewed workspace package path ${specifier}`,
          );
      }
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return;
      const target = resolveTarget(specifier);
      if (runtime && target !== undefined) dependencies.push(target);
    };
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      inspectSpecifier(specifier.text, isRuntimeImport(statement));
    }
    const inspectDeferredImport = (node) => {
      const argument =
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
      if (
        argument &&
        ts.isStringLiteral(argument) &&
        (argument.text.startsWith('.') ||
          argument.text.startsWith('@/') ||
          argument.text.startsWith('@pertexo/'))
      )
        inspectSpecifier(argument.text, false);
      ts.forEachChild(node, inspectDeferredImport);
    };
    inspectDeferredImport(source);
    const inspectRawFetch = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isGlobalFetch =
          ts.isIdentifier(callee) && callee.text === 'fetch'
            ? true
            : ts.isPropertyAccessExpression(callee) &&
              callee.name.text === 'fetch' &&
              ts.isIdentifier(callee.expression) &&
              ['globalThis', 'self', 'window'].includes(callee.expression.text);
        if (
          isGlobalFetch &&
          file.startsWith('apps/web/src/') &&
          !webRawFetchOwners.has(file)
        )
          errors.push(
            `${file}: raw fetch belongs in the reviewed web transport adapter`,
          );
      }
      ts.forEachChild(node, inspectRawFetch);
    };
    inspectRawFetch(source);
    graph.set(file, dependencies);
  }
  const completed = new Set();
  const active = new Set();
  const visit = (file, trail) => {
    if (active.has(file)) {
      const start = trail.indexOf(file);
      errors.push(
        `runtime module cycle: ${[...trail.slice(start), file].join(' -> ')}`,
      );
      return;
    }
    if (completed.has(file)) return;
    active.add(file);
    for (const dependency of graph.get(file))
      visit(dependency, [...trail, file]);
    active.delete(file);
    completed.add(file);
  };
  for (const file of graph.keys()) visit(file, []);
  return errors;
}

export async function inspectModuleImports(directory = root) {
  const sources = {};
  const visit = async (sourceDirectory) => {
    for (const entry of await readdir(sourceDirectory, {
      withFileTypes: true,
    })) {
      const file = path.join(sourceDirectory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.d.ts')
      )
        sources[path.relative(directory, file).split(path.sep).join('/')] =
          await readFile(file, 'utf8');
    }
  };
  for (const category of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(directory, category), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(directory, category, entry.name, 'src');
      try {
        await visit(source);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return validateModuleImports(sources);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const errors = await inspectModuleImports();
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      'Source imports preserve workspace ownership and have no static local runtime cycles.',
    );
}
