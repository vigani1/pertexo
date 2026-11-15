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

const coreSource = 'packages/core/src/';

/** Whether an import or export declaration loads its module when the code runs. */
function isRuntimeDeclaration(statement) {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return true;
    if (clause.isTypeOnly) return false;
    const bindings = clause.namedBindings;
    return !(
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

function areaOf(file) {
  if (!file.startsWith(coreSource)) return undefined;
  const parts = file.slice(coreSource.length).split('/');
  return parts.length > 1 ? parts[0] : undefined;
}

/** Every import from one core area's file into another area's, with its kind. */
export function findAreaImports(file, text) {
  const from = areaOf(file);
  if (from === undefined) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const imports = [];
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith('.')) continue;
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), specifier.text),
    );
    const to = areaOf(target);
    if (to === undefined || to === from) continue;
    imports.push({
      from,
      to,
      file,
      target,
      runtime: isRuntimeDeclaration(statement),
    });
  }
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

export function areaCycleFindings(imports) {
  const closing = cycleEdges(areaGraph(imports, { runtimeOnly: true }));
  const findings = [];
  for (const edge of closing) {
    const files = imports
      .filter((i) => i.runtime && `${i.from}->${i.to}` === edge)
      .map((i) => `  ${i.file} -> ${i.target}`);
    findings.push(
      `Core area edge ${edge} closes a runtime cycle between areas:\n${files.join('\n')}`,
    );
  }
  return findings;
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
      areaCycleFindings(imports),
      'No runtime import cycle between core areas.',
    );
}
