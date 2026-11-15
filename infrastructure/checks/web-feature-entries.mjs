import ts from 'typescript';

// A web feature is reached from outside through at most four entries, each
// with one reason:
//   public.ts                 rules, hooks and data other code uses (no UI)
//   <feature>-views.public.ts components other features or routes render
//   <feature>-queries.public.ts what route loaders import, often lazily
//   <feature>-routing.public.ts what the always-loaded shell imports
// and a route imports the page it renders from the feature's pages/ folder.
// Views may use another feature's public.ts, never the reverse, which keeps
// the feature graph acyclic; the shell reaching only the routing and loader
// entries keeps pages and their dependencies out of the first load.
const FEATURE_FILE = /^apps\/web\/src\/features\/([^/]+)\/(.+)$/u;
const ENTRY_KINDS = Object.freeze({
  public: (rel) => !/^\.\/(?:components|pages)\//u.test(rel),
  views: (rel) => rel.startsWith('./components/'),
  queries: (rel) => rel.startsWith('./data/'),
  routing: () => true,
});
// The always-loaded shell: what main.tsx reaches statically.
const SHELL_ROOT = 'apps/web/src/main.tsx';

/** The entry kind a feature-root file is, or undefined. */
function featureEntryKind(feature, name) {
  if (name === 'public.ts') return 'public';
  for (const kind of ['views', 'queries', 'routing'])
    if (name === `${feature}-${kind}.public.ts`) return kind;
  return undefined;
}

/** Whether `importer` may import `@/features/<feature>/<target>`. */
export function isFeatureEntry(importer, feature, target) {
  if (featureEntryKind(feature, `${target}.ts`) !== undefined) return true;
  return (
    importer.startsWith('apps/web/src/routes/') &&
    /^pages\/[^/]+$/u.test(target)
  );
}

/** Findings for one web feature file: entries sit at the root and only re-export. */
export function featureEntryViolations(file, source) {
  const match = FEATURE_FILE.exec(file);
  if (
    match === null ||
    (!file.endsWith('.public.ts') && !file.endsWith('/public.ts'))
  )
    return [];
  const [, feature, rest] = match;
  const kind = rest.includes('/') ? undefined : featureEntryKind(feature, rest);
  if (kind === undefined)
    return [
      `${file}: a feature's entries are public.ts, ${feature}-views.public.ts, ${feature}-queries.public.ts and ${feature}-routing.public.ts at its root`,
    ];
  const findings = [];
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      findings.push(
        `${file}: an entry only re-exports; move this code into the feature's model/`,
      );
      continue;
    }
    const rel = statement.moduleSpecifier.text;
    if (!ENTRY_KINDS[kind](rel))
      findings.push(`${file}: ${rel} does not belong in a ${kind} entry`);
  }
  return findings;
}

/**
 * Feature modules the shell loads statically other than through a routing or
 * loader entry. `graph` maps each source to its static runtime dependencies.
 */
export function shellEntryViolations(graph) {
  if (!graph.has(SHELL_ROOT)) return [];
  const findings = [];
  const seen = new Set([SHELL_ROOT]);
  const queue = [[SHELL_ROOT]];
  while (queue.length > 0) {
    const trail = queue.shift();
    for (const next of graph.get(trail.at(-1)) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const match = FEATURE_FILE.exec(next);
      if (match === null) {
        queue.push([...trail, next]);
        continue;
      }
      const kind = featureEntryKind(match[1], match[2]);
      if (kind !== 'routing' && kind !== 'queries')
        findings.push(
          `${trail.at(-1)}: the always-loaded shell reaches ${next} (${[...trail, next].join(' -> ')}); import it through ${match[1]}-routing.public.ts`,
        );
    }
  }
  return findings;
}
