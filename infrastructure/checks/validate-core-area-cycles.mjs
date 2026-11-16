import console from 'node:console';
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
import { loadsModule } from './module-declarations.mjs';
import {
  coreAreaDependencyAllowed,
  GUARDED_CORE_AREA_EDGES,
  GUARDED_CORE_AREA_EDGE_BUDGET,
  isCoreArea,
} from './core-area-order.mjs';

const coreSource = 'packages/core/src/';

function areaOf(file) {
  if (!file.startsWith(coreSource)) return undefined;
  const parts = file.slice(coreSource.length).split('/');
  return parts.length > 1 ? parts[0] : undefined;
}

const CORE_ENTRY = '@pertexo/core/';

/** A specifier as the core file it reaches: relative, or core's own `@pertexo/core/<area>` entry. */
function reachedFile(file, specifier) {
  if (specifier.startsWith(CORE_ENTRY))
    return `${coreSource}${specifier.slice(CORE_ENTRY.length)}/index.ts`;
  if (!specifier.startsWith('.')) return undefined;
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
}

/**
 * Every import from one core area's file into another area's, with its kind:
 * static imports and re-exports, and `import()` calls, which load at run time.
 */
export function findAreaImports(file, text) {
  const from = areaOf(file);
  if (from === undefined) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const record = (specifier, runtime) => {
    const target = reachedFile(file, specifier);
    const to = target === undefined ? undefined : areaOf(target);
    if (to === undefined || to === from) return;
    imports.push({ from, to, file, target, runtime });
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      record(node.moduleSpecifier.text, loadsModule(node));
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      record(node.arguments[0].text, true);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** Tarjan's strongly connected components over `edges` (a Map of Sets). */
export function stronglyConnectedGroups(edges) {
  const nodes = new Set(edges.keys());
  for (const targets of edges.values()) for (const t of targets) nodes.add(t);
  let index = 0;
  const indices = new Map();
  const lows = new Map();
  const stack = [];
  const onStack = new Set();
  const groups = [];
  const visit = (node) => {
    indices.set(node, index);
    lows.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lows.set(node, Math.min(lows.get(node), lows.get(next)));
      } else if (onStack.has(next))
        lows.set(node, Math.min(lows.get(node), indices.get(next)));
    }
    if (lows.get(node) !== indices.get(node)) return;
    const group = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      group.push(member);
    } while (member !== node);
    if (group.length > 1) groups.push(group.sort());
  };
  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);
  return groups.sort((a, b) => a[0].localeCompare(b[0]));
}

export function areaGraph(imports, { runtimeOnly }) {
  const edges = new Map();
  for (const edge of imports) {
    if (runtimeOnly && !edge.runtime) continue;
    if (!edges.has(edge.from)) edges.set(edge.from, new Set());
    edges.get(edge.from).add(edge.to);
  }
  return edges;
}

/** Edges whose two ends sit in one strongly connected group: each closes a cycle. */
export function cycleEdges(edges) {
  const groupOf = new Map();
  for (const group of stronglyConnectedGroups(edges))
    for (const area of group) groupOf.set(area, group);
  const closing = [];
  for (const [from, targets] of edges)
    for (const to of targets)
      if (groupOf.has(from) && groupOf.get(from) === groupOf.get(to))
        closing.push(`${from}->${to}`);
  return closing.sort();
}

/** Edges that close a cycle between areas, type-only imports included: areas depend one way. */
export function areaCycleFindings(imports) {
  const closing = cycleEdges(areaGraph(imports, { runtimeOnly: false }));
  const findings = [];
  for (const edge of closing) {
    const files = imports
      .filter((i) => `${i.from}->${i.to}` === edge)
      .map(
        (i) =>
          `  ${i.runtime ? 'runtime' : 'type-only'} ${i.file} -> ${i.target}`,
      );
    findings.push(
      `Core area edge ${edge} closes a cycle between areas:\n${files.join('\n')}`,
    );
  }
  return findings;
}

/**
 * Imports against CORE_AREA_LAYERS, of any kind: up or across the order, a
 * cut edge, or an area the table doesn't name. The relative runtime ones
 * validate-module-imports.mjs refuses too; this adds type-only imports,
 * `import()` calls and core's own entries.
 */
export function areaOrderFindings(imports) {
  const findings = new Set();
  for (const i of imports)
    for (const area of [i.from, i.to])
      if (!isCoreArea(area))
        findings.add(
          `Core area ${area} is not in CORE_AREA_LAYERS (core-area-order.mjs); give it a layer.`,
        );
  for (const i of imports)
    if (
      isCoreArea(i.from) &&
      isCoreArea(i.to) &&
      !coreAreaDependencyAllowed(i.from, i.to)
    )
      findings.add(
        `${i.file} -> ${i.target}: ${i.from} may not import ${i.to}; areas import only the layers below theirs in CORE_AREA_LAYERS.`,
      );
  return [...findings];
}

/** A listed guarded edge no import uses only widens what the order allows. */
export function guardedEdgeFindings(
  imports,
  guarded = GUARDED_CORE_AREA_EDGES,
) {
  const used = new Set(imports.map((i) => `${i.from} -> ${i.to}`));
  const budgetFindings =
    Object.keys(guarded).length > GUARDED_CORE_AREA_EDGE_BUDGET
      ? [
          `GUARDED_CORE_AREA_EDGES exceeds its fixed budget of ${GUARDED_CORE_AREA_EDGE_BUDGET}; any increase requires a reviewed budget change.`,
        ]
      : [];
  return [
    ...budgetFindings,
    ...Object.keys(guarded)
      .filter((edge) => !used.has(edge))
      .map(
        (edge) =>
          `GUARDED_CORE_AREA_EDGES lists ${edge}, which no core import uses; remove it.`,
      ),
  ];
}

export async function collectAreaImports(root = repositoryRoot) {
  const imports = [];
  for (const file of await listSourceFiles('packages/core', root))
    imports.push(...findAreaImports(file, await readSource(file, root)));
  return imports;
}

/** The area graph as text: groups for both kinds, then every edge with counts. */
export function describeAreaGraph(imports) {
  const lines = [];
  for (const [title, runtimeOnly] of [
    ['runtime imports only', true],
    ['including type-only imports', false],
  ]) {
    lines.push(`## Strongly connected groups, ${title}`);
    const groups = stronglyConnectedGroups(areaGraph(imports, { runtimeOnly }));
    if (groups.length === 0) lines.push('- none');
    for (const group of groups)
      lines.push(`- ${group.length} areas: ${group.join(', ')}`);
    lines.push('');
  }
  const counts = new Map();
  for (const i of imports) {
    const key = `${i.from}->${i.to}`;
    const entry = counts.get(key) ?? { runtime: 0, type: 0 };
    if (i.runtime) entry.runtime += 1;
    else entry.type += 1;
    counts.set(key, entry);
  }
  lines.push('## Edges (runtime file imports / type-only file imports)');
  for (const key of [...counts.keys()].sort())
    lines.push(
      `${key}: ${counts.get(key).runtime} runtime / ${counts.get(key).type} type-only`,
    );
  lines.push('', '## Files on every edge that closes a cycle (with type-only)');
  for (const edge of cycleEdges(areaGraph(imports, { runtimeOnly: false }))) {
    lines.push(`${edge}:`);
    for (const i of imports.filter((x) => `${x.from}->${x.to}` === edge))
      lines.push(
        `  ${i.runtime ? 'runtime' : 'type   '} ${i.file.slice(coreSource.length)} -> ${i.target.slice(coreSource.length)}`,
      );
  }
  return lines.join('\n');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const imports = await collectAreaImports();
  if (process.argv.includes('--map')) console.log(describeAreaGraph(imports));
  else
    report(
      [
        ...areaCycleFindings(imports),
        ...areaOrderFindings(imports),
        ...guardedEdgeFindings(imports),
      ],
      'Core areas import only the layers below theirs, with no cycle, type-only imports included.',
    );
}
