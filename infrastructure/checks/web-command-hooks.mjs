import path from 'node:path';

import ts from 'typescript';

// The hooks that build a server command. A web feature defines its command
// hooks in its data/ folder (data/<subject>.mutations.ts or data/mutations/),
// next to the endpoint calls and the cache effects they own; components and
// pages call those hooks, never these builders.
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
    if (builders === undefined || !bindings || !ts.isNamedImports(bindings))
      continue;
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
