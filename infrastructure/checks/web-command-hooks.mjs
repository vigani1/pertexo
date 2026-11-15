import path from 'node:path';

import ts from 'typescript';

// Only a web feature's data/ folder talks to the server. It holds the
// endpoint modules (`*.api.ts`), the command hooks built on the helpers
// below (data/<subject>.mutations.ts or data/mutations/), and the named
// streams, downloads and journeys the rest of the feature calls. Components,
// pages, hooks, forms and models call those, never an endpoint or a builder.
const COMMAND_BUILDERS = Object.freeze({
  '@tanstack/react-query': ['useMutation'],
  '@/lib/api/commands/use-retained': ['useRetainedCommand'],
  '@/lib/api/commands/low-effect-mutation': ['useLowEffectMutation'],
  '@/lib/api/commands/use-create-command': ['useCreateCommand'],
  '@/lib/resource-sharing/use-editor': ['useSharingEditor'],
});
const WEB_SOURCE = 'apps/web/src/';
// The shared builders compose each other; a feature's data/ binds them to
// its endpoints.
const COMMAND_OWNERS = [
  /^apps\/web\/src\/features\/[^/]+\/data\//u,
  /^apps\/web\/src\/lib\/api\/commands\//u,
  /^apps\/web\/src\/lib\/resource-sharing\//u,
];

/** Findings for one web source file that builds a command outside data/. */
export function commandHookViolations(file, source) {
  if (!file.startsWith(WEB_SOURCE)) return [];
  if (COMMAND_OWNERS.some((owner) => owner.test(file))) return [];
  const findings = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const builders =
      COMMAND_BUILDERS[aliasOf(file, statement.moduleSpecifier.text)];
    const bindings = statement.importClause?.namedBindings;
    if (builders === undefined || !bindings) continue;
    // `import * as RQ` would reach every builder as `RQ.useMutation`.
    if (ts.isNamespaceImport(bindings)) {
      findings.push(
        `${file}: a namespace import of ${statement.moduleSpecifier.text} reaches its command builders (${builders.join(', ')}); import the names you need`,
      );
      continue;
    }
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && builders.includes(name))
        findings.push(
          `${file}: ${name} builds a server command; define the hook in the feature's data/ folder (data/<subject>.mutations.ts or data/mutations/) and call it here`,
        );
    }
  }
  return findings;
}

// A relative specifier inside the web app, spelled as its `@/` alias.
function aliasOf(file, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const target = path.posix.join(path.posix.dirname(file), specifier);
  return target.startsWith(WEB_SOURCE)
    ? `@/${target.slice(WEB_SOURCE.length).replace(/\.tsx?$/u, '')}`
    : specifier;
}

// Who may import an endpoint module: the feature's data/ folder, its loader
// entry (`<feature>-queries.public.ts`, which re-exports for other features'
// data/), the shared transport, and the shared sharing editor's own data
// modules (`lib/resource-sharing`, used by connections and folders).
const ENDPOINT_IMPORTERS = [
  /^apps\/web\/src\/features\/[^/]+\/data\//u,
  /^apps\/web\/src\/features\/([^/]+)\/\1-queries\.public\.ts$/u,
  /^apps\/web\/src\/lib\/api\//u,
  /^apps\/web\/src\/lib\/resource-sharing\/[^/]+\.(?:api|queries|mutations)\.ts$/u,
];
const ENDPOINT_MODULE = /\.api(?:\.[jt]s)?$/u;

/** Findings for one web source file that imports an endpoint module outside data/. */
export function endpointImportViolations(file, source) {
  if (!file.startsWith(WEB_SOURCE)) return [];
  if (ENDPOINT_IMPORTERS.some((importer) => importer.test(file))) return [];
  const findings = dynamicEndpointImports(file, source);
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !ENDPOINT_MODULE.test(statement.moduleSpecifier.text)
    )
      continue;
    if (carriesValues(statement))
      findings.push(
        `${file}: ${statement.moduleSpecifier.text} calls the server; call a named function or hook from the feature's data/ folder, or read another feature through its -queries.public entry`,
      );
  }
  return findings;
}

// Whether a declaration brings a value (not only types) across.
function carriesValues(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name !== undefined) return true;
    const bindings = clause.namedBindings;
    if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some((element) => !element.isTypeOnly);
  }
  if (statement.isTypeOnly) return false;
  const clause = statement.exportClause;
  if (clause === undefined || !ts.isNamedExports(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

// `import('../data/tables.api')` loads an endpoint module as surely as a
// static import does.
function dynamicEndpointImports(file, source) {
  const findings = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ENDPOINT_MODULE.test(node.arguments[0].text)
    )
      findings.push(
        `${file}: import('${node.arguments[0].text}') calls the server; call a named function or hook from the feature's data/ folder`,
      );
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
