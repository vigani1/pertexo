import console from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const webAllowedWorkspaceImports = new Set([
  '@pertexo/node-sdk',
  '@pertexo/contracts',
  '@pertexo/workflow-model',
  '@pertexo/templates',
  '@pertexo/integrations',
]);
// Tables and primitives are what core builds on; applications go through core.
const coreOnlyDatabaseEntries = new Set([
  '@pertexo/database/schema',
  '@pertexo/database/primitives',
]);
// All an application ever needs from the database: pools and startup, plus fixtures.
const applicationDatabaseEntries = new Set([
  '@pertexo/database/platform',
  '@pertexo/database/testing',
]);
const webRawFetchOwners = new Set([
  'apps/web/src/lib/api/client.ts',
  'apps/web/src/features/artifacts/data/upload.api.ts',
]);

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

const coreSource = 'packages/core/src/';
/**
 * Areas that have moved into core and haven't had their pass (ADR 091). Reaching
 * into one isn't checked; its pass takes it off this list. It can only shrink: the
 * test beside this check pins it.
 */
export const AREAS_NOT_YET_PASSED = new Set([
  'artifacts',
  'attempts',
  'authoring',
  'connections',
  'data-tables',
  'execution',
  'identity',
  'inbox',
  'lifecycle',
  'notifications',
  'operator',
  'outbox',
  'previews',
  'runs',
  'tenant-access',
  'triggers',
]);
// Tests answer only to the direction rules, but they do answer to them.
const SCANNED_FOLDERS = ['src', 'test', 'e2e', 'e2e-live'];

/**
 * What a relative import inside a core area reaches: a door at core's root, which
 * sits above every area, or a passed area by anything but a file its index names.
 * Going through the index itself would turn the areas' cycle into file cycles.
 */
function coreAreaViolation(file, specifier, namedFiles) {
  if (!file.startsWith(coreSource) || !specifier.startsWith('.')) return;
  const [area, ...own] = file.slice(coreSource.length).split('/');
  if (own.length === 0) return;
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
  if (!target.startsWith(coreSource)) return;
  const [targetArea, ...rest] = target.slice(coreSource.length).split('/');
  if (rest.length === 0)
    return `core areas don't import core's entry points; ${specifier} sits above them`;
  if (targetArea === area || AREAS_NOT_YET_PASSED.has(targetArea)) return;
  const reached = rest.join('/');
  if (reached === 'index.js')
    return `core areas import the files ${targetArea}/index.ts names, never the index`;
  if (!namedFiles(targetArea).has(reached))
    return `core areas import the files ${targetArea}/index.ts names, and it doesn't name ${reached}`;
}

/** The relative files one core area's index re-exports from: its public files. */
function indexNamedFiles(sources) {
  const named = new Map();
  return (area) => {
    if (named.has(area)) return named.get(area);
    const index = `${coreSource}${area}/index.ts`;
    const files = new Set();
    const text = sources[index];
    if (text !== undefined)
      for (const statement of ts.createSourceFile(
        index,
        text,
        ts.ScriptTarget.Latest,
        true,
      ).statements)
        if (
          ts.isExportDeclaration(statement) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.startsWith('./')
        )
          files.add(statement.moduleSpecifier.text.slice(2));
    named.set(area, files);
    return files;
  };
}

/** A database entry point meant for core, by name or by a path around its door. */
function reachesDatabaseCode(file, specifier) {
  if (coreOnlyDatabaseEntries.has(specifier)) return true;
  if (!specifier.startsWith('.')) return false;
  return /^packages\/database\/(?:src|dist)(?:\/|$)/u.test(
    path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)),
  );
}

/**
 * Rules that hold for a workspace's tests as well as its source. A deliberate
 * limit: only import syntax is read, so a name passed as a plain string, as in
 * `vi.importActual('@pertexo/database/schema')`, isn't seen. A string is only a
 * module name to the function that takes it, and no test does this today.
 */
function directionViolations(file, specifier) {
  const violations = [];
  if (
    (specifier === '@pertexo/core' || specifier.startsWith('@pertexo/core/')) &&
    file.startsWith('packages/') &&
    !file.startsWith('packages/core/')
  )
    violations.push(
      `${file}: only applications depend on core (apps -> core -> database)`,
    );
  if (
    reachesDatabaseCode(file, specifier) &&
    !file.startsWith('packages/core/') &&
    !file.startsWith('packages/database/')
  )
    violations.push(
      `${file}: ${specifier} is for core; applications use a core area`,
    );
  if (
    file.startsWith('apps/') &&
    /^@pertexo\/database(?:\/|$)/u.test(specifier) &&
    !coreOnlyDatabaseEntries.has(specifier) &&
    !applicationDatabaseEntries.has(specifier)
  )
    violations.push(
      `${file}: applications reach the database only through @pertexo/database/platform and, from tests, /testing; ${specifier} belongs in a core area`,
    );
  return violations;
}

/** Rules that hold only for what ships: test doors, and a package's own name. */
function sourceViolations(file, specifier) {
  const violations = [];
  if (/^@pertexo\/[^/]+\/testing$/u.test(specifier))
    violations.push(
      `${file}: ${specifier} holds test flows and fixtures; production code can't load it`,
    );
  const [, workspaceName] = file.split('/');
  if (
    specifier === `@pertexo/${workspaceName}` ||
    specifier.startsWith(`@pertexo/${workspaceName}/`)
  )
    violations.push(
      `${file}: a package reaches its own code by relative path, not through ${specifier}`,
    );
  return violations;
}

const isSource = (file) => /^(?:apps|packages)\/[^/]+\/src\//u.test(file);

/** Static local runtime imports only; deferred imports do not create startup cycles. */
export function validateModuleImports(sources) {
  const errors = [];
  const graph = new Map();
  const namedFiles = indexNamedFiles(sources);
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
      errors.push(...directionViolations(file, specifier));
      if (!isSource(file)) return;
      errors.push(...sourceViolations(file, specifier));
      if (
        file.startsWith('apps/code-runner/src/') &&
        specifier.startsWith('@pertexo/') &&
        specifier !== '@pertexo/node-sdk' &&
        specifier !== '@pertexo/node-sdk/server'
      )
        errors.push(
          `${file}: Code runner may depend only on the credential-free node SDK`,
        );

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
      const areaViolation = coreAreaViolation(file, specifier, namedFiles);
      if (areaViolation !== undefined) errors.push(`${file}: ${areaViolation}`);
      if (runtime && target !== undefined) dependencies.push(target);
    };
    for (const statement of source.statements) {
      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteralLike(statement.moduleReference.expression)
      ) {
        inspectSpecifier(
          statement.moduleReference.expression.text,
          !statement.isTypeOnly,
        );
        continue;
      }
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
        ts.isStringLiteralLike(argument) &&
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
      for (const folder of SCANNED_FOLDERS) {
        try {
          await visit(path.join(directory, category, entry.name, folder));
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
  }
  return [
    ...(await inspectListedAreas(directory)),
    ...validateModuleImports(sources),
  ];
}

/** A listed area with no folder is a pass that forgot to shorten the list. */
async function inspectListedAreas(directory) {
  let entries;
  try {
    entries = await readdir(path.join(directory, coreSource));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return [...AREAS_NOT_YET_PASSED]
    .filter((area) => !entries.includes(area))
    .map(
      (area) =>
        `${area} is on AREAS_NOT_YET_PASSED, but core has no such area: take it off the list`,
    );
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
